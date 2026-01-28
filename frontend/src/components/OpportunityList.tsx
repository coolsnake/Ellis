import React from 'react';
import { ROUTES } from '../utils/routes';

type BottleneckEdge = { from: string; to: string; dex: string; rate: number; liquidity: number; fee_bps: number };
type Opportunity = {
  path: string[];
  profit_bps: number;
  net_bps?: number;
  est_profit_usd: number;
  dexes: string[];
  hop_dexes?: string[];
  hop_rates?: number[];
  hop_outs?: number[];
  hop_pool_ids?: string[];
  hop_fee_bps?: number[];
  hop_liquidity_display?: number[];
  hop_count?: number;
  rate_product?: number;
  link_edges_used?: number;
  link_penalty_bps_total?: number;
  min_edge_liquidity?: number;
  est_capacity?: number;
  bottleneck?: BottleneckEdge;
  detected_ms?: number;
  first_seen_ms?: number;
  last_verified_ms?: number;
  detections?: number;
};

type WalletBalances = {
  sol?: number;
  tokens?: Record<string, number>;
};

// Types for execution results from backend socket events
type ExecutionResult = {
  type: 'success' | 'sim_failed' | 'exec_failed';
  timestamp: number;
  traceId?: string;
  signature?: string;
  error?: string;
  profitBps?: number;
  netBps?: number;
  analysis?: {
    swapsExecuted: number;
    totalHops: number;
    profitCheckFailed: boolean;
    failedAt?: number | 'profit_check';
    adaptiveAttempts?: number;
  };
  simulationDetails?: {
    swapsExecuted: Array<{ step: number; dex: string; amountIn: string; minOut: string }>;
    /** Actual hop outputs from VERBOSE logs (real in/out per hop) */
    hopActualOutputs?: Array<{ hop: number; amountIn: string; amountOut: string; dex: string }>;
    /** Expected hop outputs from resolver quotes (in raw units, actual execution size) */
    hopQuotedOutputs?: Array<{ quotedOutputRaw?: string; amountInRaw?: string; dex: string; poolId: string }>;
    profitValue?: string;
    minProfitRequired?: string;
    initialBalance?: string;
    finalBalance?: string;
    errorCode?: number;
    errorMessage?: string;
  };
  executionContext?: {
    sizeUsd?: number;
    adaptiveAttempts?: number;
    durationMs?: number;
    usedFlashloan?: boolean;
    skipSimulation?: boolean;
  };
};

export function OpportunityList(
  {
    items,
    tokenMap,
    quoteSize,
    quoteSizeMint,
    sendMode,
    sendAmount,
    apiBase,
    socket,
    walletBalances,
  }: {
    items: Opportunity[];
    tokenMap: Record<string, string>;
    quoteSize: number;
    quoteSizeMint: string;
    sendMode: 'USD' | 'TOKENS';
    sendAmount: number;
    apiBase: string;
    socket?: any;
    walletBalances?: WalletBalances | null;
  }
): React.ReactElement {
  const [showAll, setShowAll] = React.useState(false);
  const [simLogs, setSimLogs] = React.useState<string[] | null>(null);
  const [simErr, setSimErr] = React.useState<string | null>(null);
  // Track execution results per opportunity
  const [executionResults, setExecutionResults] = React.useState<Map<string, ExecutionResult[]>>(new Map());

  // Helper to create opportunity key for matching
  const getOpportunityKey = React.useCallback((pathMints: string[], hopPoolIds?: string[]) => {
    if (hopPoolIds?.length) {
      return `${pathMints.join('>')}|${hopPoolIds.join('>')}`;
    }
    return pathMints.join('>');
  }, []);

  // Subscribe to execution result events from backend
  React.useEffect(() => {
    if (!socket) return;

    const handleExecutionResult = (data: any, type: 'success' | 'sim_failed' | 'exec_failed') => {
      // Use pathMints and hopPoolIds from enriched event payload
      const pathMints = data.pathMints || [];
      const hopPoolIds = data.hopPoolIds || [];
      if (!pathMints.length) return; // Can't match without path

      const key = getOpportunityKey(pathMints, hopPoolIds);

      setExecutionResults(prev => {
        const newMap = new Map(prev);
        const existing = newMap.get(key) || [];
        // Keep last 5 results per opportunity
        const updated: ExecutionResult[] = [
          {
            type,
            timestamp: data.timestamp || Date.now(),
            traceId: data.traceId,
            signature: data.signature,
            error: data.error,
            profitBps: data.profitBps,
            netBps: data.netBps,
            analysis: data.analysis,
            simulationDetails: data.simulationDetails,
            executionContext: data.executionContext,
          },
          ...existing.slice(0, 4),
        ];
        newMap.set(key, updated);
        return newMap;
      });
    };

    const onSuccess = (data: any) => handleExecutionResult(data, 'success');
    const onSimFailed = (data: any) => handleExecutionResult(data, 'sim_failed');
    const onExecFailed = (data: any) => handleExecutionResult(data, 'exec_failed');

    try { socket.on('arb:execution', onSuccess); } catch {}
    try { socket.on('arb:simulation:failed', onSimFailed); } catch {}
    try { socket.on('arb:execution:failed', onExecFailed); } catch {}

    return () => {
      try { socket.off('arb:execution', onSuccess); } catch {}
      try { socket.off('arb:simulation:failed', onSimFailed); } catch {}
      try { socket.off('arb:execution:failed', onExecFailed); } catch {}
    };
  }, [socket, getOpportunityKey]);

  const fmt = (n: number | undefined | null, digits = 0) => {
    if (n === undefined || n === null || isNaN(n as any)) return '—';
    const v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  };
  const fmtPctFromBps = (bps?: number) => bps === undefined || bps === null ? '—' : `${(bps/100).toFixed(2)}%`;

  const ago = (ms?: number) => {
    if (!ms || ms <= 0) return '—';
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h`;
  };

  const visible = React.useMemo(() => (showAll ? items : items.slice(0, 10)), [showAll, items]);

  // Check if opportunity can be executed based on balance
  const checkBalance = React.useCallback((op: Opportunity): { hasBalance: boolean; balance: number; startToken: string } => {
    if (!walletBalances || !op.path || op.path.length === 0) {
      return { hasBalance: true, balance: 0, startToken: '' };
    }
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const startToken = op.path[0];
    const balance = startToken === SOL_MINT
      ? (walletBalances.sol || 0)
      : (walletBalances.tokens?.[startToken] || 0);
    return { hasBalance: balance > 0, balance, startToken };
  }, [walletBalances]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs opacity-70">{showAll ? `Showing ${items.length}` : `Showing ${Math.min(10, items.length)} of ${items.length}`}</span>
        <button className="px-2 py-1 border rounded" onClick={()=> setShowAll(!showAll)}>{showAll ? 'Show Top 10' : 'Show All'}</button>
      </div>
      <div className="max-h-[1200px] overflow-y-auto">
        <div className="space-y-2">
        {visible.map((op) => {
          const key = `${(op.path||[]).join('>')}|${(op.dexes||[]).join('>')}`;
          const balanceInfo = checkBalance(op);
          return (
          <div key={key} className={`p-2 border rounded ${balanceInfo.hasBalance ? 'bg-black/20' : 'bg-black/20 border-yellow-600/50'}`}>
            <div className="text-sm">
              <span className="font-mono">
                {(() => {
                  const hops = op.hop_dexes || [];
                  const rates = (op as any).hop_rates || [];
                  // Do not use hop_outs for display; rotation/canonicalization can misalign
                  // their scale with the shown start token. Always derive amounts from rates.
                  const outs: number[] | undefined = undefined;
                  const fees = (op as any).hop_fee_bps as number[] | undefined;
                  const liqs = (op as any).hop_liquidity_display as number[] | undefined;
                  const startMint = op.path?.[0];
                  const pathArr = op.path || [];
                  const edgesCount = Math.max(0, pathArr.length - 1);
                  const showClosing = Array.isArray(rates) && rates.length > edgesCount;
                  let amt = startMint === quoteSizeMint ? quoteSize : 1.0;
                  const pieces: React.ReactNode[] = [];
                  for (let i = 0; i < pathArr.length; i++) {
                    const m = pathArr[i];
                    const sym = tokenMap[m] || (m.length > 6 ? `${m.slice(0,4)}…${m.slice(-4)}` : m);
                    const dex = hops[i % (hops.length || 1)];
                    const color = dex === 'Raydium' ? 'text-green-400' : (dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
                    const rate = Number.isFinite(rates[i % (rates.length || 1)]) ? rates[i % (rates.length || 1)] : undefined;
                    const fee = fees && Number.isFinite(fees[i % (fees.length || 1)] as any) ? fees[i % (fees.length || 1)] : undefined;
                    const liq = liqs && Number.isFinite(liqs[i % (liqs.length || 1)] as any) ? liqs[i % (liqs.length || 1)] : undefined;
                    const out = undefined;
                    pieces.push(
                      <span key={`${m}-${i}`}>
                        <span className="font-semibold">{sym}</span>{i===0?` (${amt.toFixed(4)})`:''}
                        {i < pathArr.length - 1 && (
                          <span> <span className={`px-1 rounded ${color}`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{rate ? ` · ×${(rate as number).toFixed(4)} → ${(amt * (rate as number)).toFixed(4)}` : ''}</span> → </span>
                        )}
                      </span>
                    );
                    if (i < pathArr.length - 1) {
                      if (rate) amt = amt * (rate as number);
                    }
                  }
                  if (showClosing) {
                    const i = edgesCount;
                    const last = pathArr[pathArr.length - 1];
                    const first = pathArr[0];
                    const dex = hops[i % (hops.length || 1)];
                    const color = dex === 'Raydium' ? 'text-green-400' : (dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
                    const rate = Number.isFinite(rates[i]) ? rates[i] : undefined;
                    const fee = fees && Number.isFinite((fees as any)[i] as any) ? (fees as any)[i] : undefined;
                    const liq = liqs && Number.isFinite((liqs as any)[i] as any) ? (liqs as any)[i] : undefined;
                    const out = undefined;
                    pieces.push(
                      <span key={`${last}-close`}>
                        <span className="font-semibold">{tokenMap[last] || (last.length > 6 ? `${last.slice(0,4)}…${last.slice(-4)}` : last)}</span>
                        <span> <span className={`px-1 rounded ${color}`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{rate ? ` · ×${(rate as number).toFixed(4)} → ${(amt * (rate as number)).toFixed(4)}` : ''}</span> → </span>
                        <span className="font-semibold">{tokenMap[first] || (first.length > 6 ? `${first.slice(0,4)}…${first.slice(-4)}` : first)}</span>
                      </span>
                    );
                  }
                  return pieces;
                })()}
              </span>
            </div>
            <div className="text-xs opacity-80">DEXes: {op.dexes.join(', ')}</div>
            <div className="text-xs">Profit: {fmtPctFromBps(op.profit_bps)} · Net: {fmtPctFromBps(op.net_bps)} · ${fmt(op.est_profit_usd, 2)}{Number.isFinite(op.est_capacity as any) ? ` · Cap: ${fmt(op.est_capacity, 2)}` : ''}</div>
            {!balanceInfo.hasBalance && walletBalances && (
              <div className="text-xs text-yellow-400 mt-1 flex items-center gap-2">
                <span>⚠️ Insufficient balance</span>
                <span className="opacity-70">({tokenMap[balanceInfo.startToken] || balanceInfo.startToken.slice(0, 8) + '...'}: {fmt(balanceInfo.balance, 6)})</span>
                <span className="opacity-60 text-[10px]">Balance check only applies during execution</span>
              </div>
            )}
            <div className="text-[11px] opacity-80 flex items-center gap-2">Hops: {op.hop_count ?? op.path.length} · Links: {op.link_edges_used ?? 0} · Min Edge Liq: {fmt(op.min_edge_liquidity, 2)}
              <button className="px-1 py-0.5 border rounded" onClick={()=>{
                try {
                  const ids = (op as any)?.hop_pool_ids as string[] | undefined;
                  if (ids && ids.length) {
                    try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { edgeIds: ids } })); } catch {}
                    if (socket) { try { socket.emit('graph-highlight', { edgeIds: ids }); } catch {} }
                  }
                } catch {}
              }}>Highlight</button>
              {(() => {
                const hopIds = ((op as any)?.hop_pool_ids || []) as string[];
                const hopDexes = ((op as any)?.hop_dexes || []) as string[];
                const expectedHops = Math.max(0, ((op.hop_count ?? op.path?.length) || 0));
                const validHops = expectedHops > 0 && hopIds.length === expectedHops && hopDexes.length === expectedHops;
                const pathClosed = op.path && op.path.length ? [...op.path, op.path[0]] : op.path;
                return (
              <button className="px-1 py-0.5 border rounded" disabled={!validHops} title={!validHops ? `Invalid hops: expected ${expectedHops}, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length}` : undefined} onClick={async()=>{
                try {
                  if (!validHops) { setSimErr(`invalid opportunity payload (expected ${expectedHops} hops, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length})`); return; }
                  const body: any = { path: pathClosed, hopPoolIds: hopIds, dexes: hopDexes };
                  const r = await fetch(`${apiBase}${ROUTES.arb.simulate}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                  await r.json().catch(()=>({}));
                } catch {}
              }}>Simulate Direct</button>
                ); })()}
              {(() => {
                const hopIds = ((op as any)?.hop_pool_ids || []) as string[];
                const hopDexes = ((op as any)?.hop_dexes || []) as string[];
                const expectedHops = Math.max(0, ((op.hop_count ?? op.path?.length) || 0));
                const validHops = expectedHops > 0 && hopIds.length === expectedHops && hopDexes.length === expectedHops;
                const pathClosed = op.path && op.path.length ? [...op.path, op.path[0]] : op.path;
                return (
              <button className="px-1 py-0.5 border rounded" disabled={!validHops} title={!validHops ? `Invalid hops: expected ${expectedHops}, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length}` : undefined} onClick={async()=>{
                try {
                  setSimLogs(null); setSimErr(null);
                  if (!validHops) { setSimErr(`invalid opportunity payload (expected ${expectedHops} hops, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length})`); return; }
                  const body: any = { path: pathClosed, hopPoolIds: hopIds, dexes: hopDexes, sizeUsd: sendMode==='USD'? Number(sendAmount)||0 : undefined, size: sendMode==='TOKENS'? Number(sendAmount)||0 : undefined };
                  const r = await fetch(`${apiBase}${ROUTES.arb.simulateSend}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                  const j = await r.json().catch(()=>({}));
                  if (!r.ok) {
                    setSimErr(String((j && (j.error || j.err)) || 'preflight_failed'));
                  } else {
                    const logs = Array.isArray(j?.logs) ? (j.logs as string[]) : [];
                    setSimLogs(logs.slice(-20));
                    setSimErr(j?.err ? String(j.err) : null);
                  }
                  try { const rh = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const jh = await rh.json(); /* panel owns tx table; this is best-effort for any listeners */ } catch {}
                } catch (e: any) {
                  setSimErr(String(e?.message || e));
                }
              }}>Preflight Simulate</button>
                ); })()}
              {(() => {
                const hopIds = ((op as any)?.hop_pool_ids || []) as string[];
                const hopDexes = ((op as any)?.hop_dexes || []) as string[];
                const expectedHops = Math.max(0, ((op.hop_count ?? op.path?.length) || 0));
                const validHops = expectedHops > 0 && hopIds.length === expectedHops && hopDexes.length === expectedHops;
                const pathClosed = op.path && op.path.length ? [...op.path, op.path[0]] : op.path;
                return (
              <button className="px-1 py-0.5 border rounded" disabled={!validHops} title={!validHops ? `Invalid hops: expected ${expectedHops}, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length}` : undefined} onClick={async()=>{
                try {
                  if (!validHops) { setSimErr(`invalid opportunity payload (expected ${expectedHops} hops, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length})`); return; }
                  const body: any = { path: pathClosed, hopPoolIds: hopIds, dexes: hopDexes, sizeUsd: sendMode==='USD'? Number(sendAmount)||0 : undefined, size: sendMode==='TOKENS'? Number(sendAmount)||0 : undefined };
                  body.forceDirect = true;
                  setSimLogs(null); setSimErr(null);
                  const r = await fetch(`${apiBase}${ROUTES.arb.execute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                  const j = await r.json().catch(()=>({}));
                  if (!r.ok) {
                    setSimErr(String((j && (j.error || j.err)) || 'send_failed'));
                  } else if (j && j.mode && j.mode !== 'direct' && j.mode !== 'simulate_then_execute') {
                    setSimErr(`Execution disabled (mode: ${j.mode}). Enable 'direct' or 'simulate → execute' in Exec Config.`);
                  }
                  try { const rh = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const jh = await rh.json(); /* best-effort */ } catch {}
                } catch {}
              }}>Execute Direct</button>
                ); })()}
              {(() => {
                const pathClosed = op.path && op.path.length ? [...op.path, op.path[0]] : op.path;
                return (
              <button className="px-1 py-0.5 border rounded" onClick={async()=>{
                try {
                  setSimLogs(null); setSimErr(null);
                  const body: any = { path: pathClosed, sizeUsd: sendMode==='USD'? Number(sendAmount)||0 : undefined, size: sendMode==='TOKENS'? Number(sendAmount)||0 : undefined };
                  body.hopDexes = Array.isArray((op as any)?.hop_dexes) ? (op as any).hop_dexes : [];
                  body.strictMinOut = true;
                  const r = await fetch(`${apiBase}${ROUTES.arb.jupiterExecute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                  const j = await r.json().catch(()=>({}));
                  if (!r.ok) setSimErr(String((j && (j.error || j.err)) || 'send_failed'));
                } catch {}
              }}>Execute via Jupiter (strict)</button>
                ); })()}
            </div>
            {(simErr || (simLogs && simLogs.length)) && (
              <div className="mt-1 p-2 bg-black/30 rounded text-[11px]">
                {simErr && <div className="text-red-400">Preflight error: {simErr}</div>}
                {simLogs && simLogs.length > 0 && (
                  <pre className="whitespace-pre-wrap break-words opacity-80">
                    {simLogs.join('\n')}
                  </pre>
                )}
              </div>
            )}
            {op.bottleneck && (() => {
              const b = op.bottleneck!;
              const fromSym = tokenMap[b.from] || (b.from.length > 6 ? `${b.from.slice(0,4)}…${b.from.slice(-4)}` : b.from);
              const toSym = tokenMap[b.to] || (b.to.length > 6 ? `${b.to.slice(0,4)}…${b.to.slice(-4)}` : b.to);
              const color = b.dex === 'Raydium' ? 'text-green-400' : (b.dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
              return (
                <div className="text-[11px] opacity-80">
                  Bottleneck: <span className={`px-1 rounded ${color}`}>{b.dex}</span> {fromSym} → {toSym} · rate {fmt(b.rate, 6)} · liq {fmt(b.liquidity, 2)}
                </div>
              );
            })()}
            <div className="text-[11px] opacity-60 flex items-center gap-2">
              <span>First {ago(op.first_seen_ms)} · Last {ago(op.detected_ms)} · Hits {op.detections ?? 1}</span>
              {(() => {
                const lastDetected = op.detected_ms || op.last_verified_ms || op.first_seen_ms || 0;
                const now = Date.now();
                const ageMs = now - lastDetected;
                // Show stale indicator if opportunity hasn't been detected in the last 60 seconds
                const isStale = ageMs > 60000;
                if (isStale && lastDetected > 0) {
                  return (
                    <span className="px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300 text-[10px]">
                      Stale ({Math.floor(ageMs / 1000)}s ago)
                    </span>
                  );
                }
                return null;
              })()}
            </div>
            {/* Execution Results Section */}
            {(() => {
              const execKey = getOpportunityKey(op.path, op.hop_pool_ids);
              const results = executionResults.get(execKey);
              if (!results?.length) return null;

              const latest = results[0];
              const statusColor = latest.type === 'success' 
                ? 'text-green-400' 
                : 'text-red-400';
              const statusIcon = latest.type === 'success' ? '✓' : '✗';
              const statusLabel = latest.type === 'success' 
                ? 'Executed' 
                : latest.type === 'sim_failed' 
                  ? 'Sim Failed' 
                  : 'Exec Failed';
              const agoSec = Math.max(0, Math.floor((Date.now() - latest.timestamp) / 1000));

              return (
                <div className="mt-2 p-2 bg-black/30 rounded text-[11px] border-l-2 border-l-blue-500/50">
                  {/* Header with status, size, time, and signature */}
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`font-semibold ${statusColor}`}>
                      {statusIcon} {statusLabel}
                    </span>
                    {latest.executionContext?.skipSimulation && (
                      <span className="px-1 rounded bg-purple-900/50 text-purple-300 text-[10px]" title="Simulation was skipped - pools were pre-validated">
                        ⚡ DIRECT
                      </span>
                    )}
                    {latest.executionContext?.sizeUsd !== undefined && (
                      <span className="px-1 rounded bg-blue-900/40 text-blue-300">
                        ${latest.executionContext.sizeUsd.toFixed(2)}
                      </span>
                    )}
                    {latest.executionContext?.durationMs !== undefined && (
                      <span className="opacity-60 text-[10px]">
                        {latest.executionContext.durationMs}ms
                      </span>
                    )}
                    <span className="opacity-70">{agoSec}s ago</span>
                    {latest.signature && (
                      <a 
                        href={`https://solscan.io/tx/${latest.signature}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-blue-400 underline"
                      >
                        {latest.signature.slice(0, 8)}…
                      </a>
                    )}
                    {results.length > 1 && (
                      <span className="opacity-60">({results.length} attempts)</span>
                    )}
                  </div>

                  {latest.type !== 'success' && (
                    <>
                      {/* Error message */}
                      {latest.error && (
                        <div className="text-red-300 mb-1 break-words" title={latest.error}>
                          {latest.error.length > 120 ? latest.error.slice(0, 120) + '...' : latest.error}
                        </div>
                      )}

                      {/* Analysis summary */}
                      {latest.analysis && (
                        <div className="flex flex-wrap gap-2 opacity-80 mb-1">
                          {/* When profit check failed, all swaps executed - show that clearly */}
                          {latest.analysis.profitCheckFailed ? (
                            <span className="text-green-400">Swaps: {latest.analysis.totalHops}/{latest.analysis.totalHops} ✓</span>
                          ) : (
                            <span>Swaps: {latest.analysis.swapsExecuted}/{latest.analysis.totalHops}</span>
                          )}
                          {latest.analysis.profitCheckFailed && (
                            <span className="px-1 rounded bg-yellow-900/40 text-yellow-300">
                              Profit Check Failed (6007)
                            </span>
                          )}
                          {/* Only show "Failed at hop X" for actual swap failures, not profit check */}
                          {latest.analysis.failedAt !== undefined && 
                           latest.analysis.failedAt !== 'profit_check' && 
                           !latest.analysis.profitCheckFailed && (
                            <span>Failed at hop {latest.analysis.failedAt}</span>
                          )}
                          {latest.analysis.adaptiveAttempts !== undefined && latest.analysis.adaptiveAttempts > 0 && (
                            <span>Retries: {latest.analysis.adaptiveAttempts}</span>
                          )}
                        </div>
                      )}

                      {/* Per-hop swap details for profit check failures (6007) */}
                      {latest.analysis?.profitCheckFailed && (
                        <div className="mt-1 p-1.5 bg-black/20 rounded">
                          <div className="font-semibold text-[10px] opacity-70 mb-1">Profit Check Details:</div>
                          
                          {/* Show actual hop outputs from VERBOSE logs if available (most useful) */}
                          {latest.simulationDetails?.hopActualOutputs && 
                           latest.simulationDetails.hopActualOutputs.length > 0 ? (
                            <div className="space-y-0.5 mb-2">
                              <div className="text-[10px] text-gray-400">Actual hop execution (from verbose logs):</div>
                              {latest.simulationDetails.hopActualOutputs.map((hop, i) => {
                                // Get expected output from resolver quotes (correct units!)
                                const quoted = latest.simulationDetails?.hopQuotedOutputs?.[i];
                                const expectedRaw = quoted?.quotedOutputRaw ? Number(quoted.quotedOutputRaw) : null;
                                const actualRaw = Number(hop.amountOut);
                                
                                // Calculate slippage in bps (negative = worse than expected)
                                let slippageBps: number | null = null;
                                if (expectedRaw && expectedRaw > 0) {
                                  slippageBps = Math.round(((actualRaw - expectedRaw) / expectedRaw) * 10000);
                                }
                                
                                // Highlight problematic hops (>50bps worse than expected)
                                const isProblematic = slippageBps !== null && slippageBps < -50;
                                
                                return (
                                  <div key={i} className={`text-[10px] opacity-80 font-mono flex gap-2 ${isProblematic ? 'bg-red-900/30 -mx-1 px-1 rounded' : ''}`}>
                                    <span className="text-gray-400">{hop.hop + 1}.</span>
                                    <span className={hop.dex === 'Orca' ? 'text-yellow-300' : hop.dex.includes('Raydium') ? 'text-green-400' : 'text-blue-300'}>
                                      {hop.dex}
                                    </span>
                                    <span>{fmt(Number(hop.amountIn), 0)} →</span>
                                    <span className="text-cyan-300">{fmt(actualRaw, 0)}</span>
                                    {expectedRaw !== null && (
                                      <span className="opacity-50">(exp: {fmt(expectedRaw, 0)})</span>
                                    )}
                                    {slippageBps !== null && (
                                      <span className={slippageBps < -50 ? 'text-red-400 font-semibold' : slippageBps < 0 ? 'text-orange-400' : 'text-green-400'}>
                                        {slippageBps >= 0 ? '+' : ''}{slippageBps}bp
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            /* Fallback: Show expected hop outputs from opportunity data */
                            op.hop_outs && op.hop_outs.length > 0 && (
                              <div className="space-y-0.5 mb-2">
                                <div className="text-[10px] text-gray-400">Expected hop sequence (no verbose logs):</div>
                                {op.hop_outs.map((hopOut, i) => (
                                  <div key={i} className="text-[10px] opacity-80 font-mono flex gap-2">
                                    <span className="text-gray-400">{i + 1}.</span>
                                    <span className={op.hop_dexes?.[i] === 'Orca' ? 'text-yellow-300' : op.hop_dexes?.[i]?.includes('Raydium') ? 'text-green-400' : 'text-blue-300'}>
                                      {op.hop_dexes?.[i] || 'Unknown'}
                                    </span>
                                    <span>→ {fmt(hopOut, 4)}</span>
                                    {op.hop_rates?.[i] && <span className="opacity-60">(@{op.hop_rates[i].toFixed(6)})</span>}
                                  </div>
                                ))}
                              </div>
                            )
                          )}

                          {/* Profit summary with initial/final from VERBOSE logs */}
                          <div className="border-t border-gray-700 pt-1 mt-1">
                            {/* Show initial → final → profit from VERBOSE logs if available */}
                            {latest.simulationDetails?.initialBalance && latest.simulationDetails?.finalBalance && (
                              <div className="text-[10px] font-mono mb-1">
                                <span className="text-gray-400">Initial:</span>{' '}
                                <span>{fmt(Number(latest.simulationDetails.initialBalance), 0)}</span>
                                <span className="text-gray-500 mx-1">→</span>
                                <span className="text-gray-400">Final:</span>{' '}
                                <span className="text-cyan-300">{fmt(Number(latest.simulationDetails.finalBalance), 0)}</span>
                                <span className="text-gray-500 mx-1">=</span>
                                <span className={Number(latest.simulationDetails.profitValue || 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                                  {Number(latest.simulationDetails.profitValue || 0) >= 0 ? '+' : ''}{fmt(Number(latest.simulationDetails.profitValue || 0), 0)}
                                </span>
                                {latest.simulationDetails.minProfitRequired && (
                                  <span className="opacity-50 ml-2">(min required: {latest.simulationDetails.minProfitRequired})</span>
                                )}
                              </div>
                            )}
                            <div className="text-[10px] font-semibold flex flex-wrap gap-3">
                              <span className="text-gray-400">
                                Expected: <span className="text-green-400">+{op.profit_bps} bps</span>
                                {op.net_bps !== undefined && op.net_bps !== op.profit_bps && (
                                  <span className="opacity-70"> (net: +{op.net_bps} bps)</span>
                                )}
                              </span>
                              {latest.simulationDetails?.profitValue !== undefined && 
                               latest.simulationDetails?.initialBalance && (
                                <span className={Number(latest.simulationDetails.profitValue) >= 0 ? 'text-green-400' : 'text-red-400'}>
                                  Actual: {(Number(latest.simulationDetails.profitValue) / Number(latest.simulationDetails.initialBalance) * 10000).toFixed(0)} bps
                                </span>
                              )}
                            </div>
                            {op.est_profit_usd !== undefined && (
                              <div className="text-[10px] opacity-60 mt-0.5">
                                Est. profit was ${op.est_profit_usd.toFixed(4)}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Other simulation details (non-6007 errors) */}
                      {!latest.analysis?.profitCheckFailed && latest.simulationDetails && (
                        <div className="opacity-70 mb-1">
                          {latest.simulationDetails.errorMessage && (
                            <span className="mr-2">Error: {latest.simulationDetails.errorMessage}</span>
                          )}
                          {latest.simulationDetails.errorCode && (
                            <span className="mr-2">Code: {latest.simulationDetails.errorCode}</span>
                          )}
                          {latest.simulationDetails.profitValue && (
                            <span>Profit: {latest.simulationDetails.profitValue}</span>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* Execution context - duration, flashloan, trace */}
                  {latest.executionContext && (
                    <div className="opacity-60 text-[10px] mt-1">
                      {latest.executionContext.durationMs !== undefined && (
                        <span>Duration: {latest.executionContext.durationMs}ms</span>
                      )}
                      {latest.executionContext.usedFlashloan && (
                        <span> · Flashloan</span>
                      )}
                      {latest.traceId && (
                        <span> · trace: {latest.traceId}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          );
        })}
        {visible.length === 0 && (
          <div className="text-sm opacity-70">No opportunities</div>
        )}
        </div>
      </div>
    </div>
  );
}

export default OpportunityList;


