import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocket } from '../app/contexts/socket';
import OpportunityList from './OpportunityList';
import { enqueueCritical, enqueueFrame, throttle } from '../utils/scheduler';
import { ExecutorControl } from './ExecutorControl';

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

type RejectedOpportunity = {
  reason: string;
  path: string[];
  hop_count?: number;
  profit_bps?: number;
  net_bps?: number;
  dexes?: string[];
  hop_dexes?: string[];
  hop_rates?: number[];
  hop_outs?: number[];
  hop_pool_ids?: string[];
};

type OpportunitiesSummary = {
  count: number;
  max_profit_bps: number;
  avg_profit_bps: number;
  avg_net_bps: number;
  avg_hop_count: number;
  avg_link_edges_used: number;
  min_edge_liquidity_avg: number;
  min_edge_liquidity_min: number;
  last_detection_ms: number;
  detection_duration_ms: number;
  ingestion_duration_ms: number;
  graph_nodes: number;
  graph_edges: number;
  pools_amm: number;
  pools_clmm: number;
  last_orca_ms: number;
  last_raydium_ms: number;
  near_miss?: Opportunity;
  near_miss_shortfall_bps?: number;
  near_misses?: Opportunity[];
  rejected_opportunities?: RejectedOpportunity[];
};

export const ArbitragePanel: React.FC<{ apiBase: string; socket?: any; showGraph: boolean; onToggleGraph: () => void; onOpenExecConfig?: () => void }> = ({ apiBase, socket, showGraph, onToggleGraph, onOpenExecConfig }) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [items, setItems] = useState<Opportunity[]>([]);
  const [criticalTop, setCriticalTop] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<OpportunitiesSummary | null>(null);
  const [tokenMap, setTokenMap] = useState<Record<string, string>>({});
  const [quoteSize, setQuoteSize] = useState<number>(50);
  const [quoteSizeMint, setQuoteSizeMint] = useState<string>('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC default
  const [sending, setSending] = useState<boolean>(false);
  const [sendMode, setSendMode] = useState<'USD'|'TOKENS'>('USD');
  const [sendAmount, setSendAmount] = useState<number>(50);
  const isFetchingRef = useRef(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [txRows, setTxRows] = useState<Array<{ id: string; timeMs: number; path: string[]; hops: Array<{ dex: string; variant: string; poolId: string }>; ixCount: number; txSizeBytes: number; status: string; signature?: string | null; logFile?: string }>>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [nmSimLogs, setNmSimLogs] = useState<string[] | null>(null);
  const [nmSimErr, setNmSimErr] = useState<string | null>(null);
  const [execStats, setExecStats] = useState<any>(null);
  const [arbMetrics, setArbMetrics] = useState<any>(null);
  const [walletBalances, setWalletBalances] = useState<{ sol?: number; tokens?: Record<string, number> } | null>(null);
  // Show-all toggle moved into OpportunityList

  // Deprecated polling/log-triggered refresh removed; rely on socket push with initial fallback

  const fmt = (n: number | undefined | null, digits = 0) => {
    if (n === undefined || n === null || isNaN(n as any)) return '—';
    const v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  };
  const fmtPctFromBps = (bps?: number) => bps === undefined || bps === null ? '—' : `${(bps/100).toFixed(2)}%`;
  const age = (ms?: number) => {
    if (!ms || ms <= 0) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago`;
  };

  const sym = (m: string) => tokenMap[m] || (m.length > 6 ? `${m.slice(0,4)}…${m.slice(-4)}` : m);
  const formatRejectedReason = (reason: string) => {
    if (!reason) return 'Rejected';
    return reason.replace(/^rejected_/, '').split('_').map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ').trim() || 'Rejected';
  };
  const rejectedDebug = useMemo(() => {
    const allow = new Set(['rejected_too_short', 'rejected_too_long', 'rejected_too_high_profit']);
    const src = summary?.rejected_opportunities;
    const list: RejectedOpportunity[] = Array.isArray(src) ? src : [];
    const filtered = list.filter((item) => allow.has(item.reason));
    
    // Deduplicate by path + reason to avoid showing the same rejection multiple times
    const seen = new Set<string>();
    const deduplicated: RejectedOpportunity[] = [];
    for (const item of filtered) {
      const pathKey = (item.path || []).join('>');
      const dexesKey = Array.isArray(item.dexes) ? item.dexes.sort().join(',') : '';
      const key = `${item.reason}:${pathKey}:${dexesKey}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(item);
      }
    }
    
    // Limit to 5 unique rejected opportunities
    return deduplicated.slice(0, 5);
  }, [summary?.rejected_opportunities]);

  const fetchOpps = async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiBase}${ROUTES.arb.opportunities}`);
      const j = await r.json();
      setItems((j?.items as Opportunity[]) || []);
      setSummary((j?.summary as OpportunitiesSummary) || null);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
      if (firstLoad) setFirstLoad(false);
    }
  };

  const fetchTokenMap = async () => {
    try {
      const r = await fetch(`${apiBase}/tokens/map`);
      const j = await r.json();
      setTokenMap((j?.map as Record<string, string>) || {});
    } catch {}
  };

  // Fetch wallet balances for balance checking (display only)
  const fetchWalletBalances = React.useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/wallet`);
      const j = await r.json();
      if (j?.balances) {
        setWalletBalances({
          sol: j.balances.sol || 0,
          tokens: j.balances.tokens || {},
        });
      }
    } catch (e) {
      // Wallet might not be set up, that's okay - we'll just show all opportunities
      setWalletBalances(null);
    }
  }, [apiBase]);

  // Store latest fetch function in ref to avoid dependency issues
  const fetchWalletBalancesRef = useRef(fetchWalletBalances);
  useEffect(() => {
    fetchWalletBalancesRef.current = fetchWalletBalances;
  }, [fetchWalletBalances]);

  // Initial fallback fetch only
  const [lastDetectionTs, setLastDetectionTs] = useState<number>(0);
  useEffect(() => {
    fetchOpps();
    fetchTokenMap();
    fetchWalletBalances();
    // Load quote size from arb config for display consistency
    (async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.config}`); const j = await r.json(); if (typeof j?.quote_size_usd === 'number') setQuoteSize(Number(j.quote_size_usd)||50); } catch {}
    })();
    (async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); const allItems = Array.isArray(j?.items) ? j.items : []; setTxRows(allItems.slice(0, 10)); } catch {}
    })();
  }, []);

  // Refresh wallet balances on wallet updates via socket (backend emits every 60s)
  // Removed polling interval - rely solely on socket events to prevent excessive requests
  useEffect(() => {
    if (!effectiveSocket) return;
    let lastFetchTime = 0;
    const MIN_FETCH_INTERVAL = 5000; // Throttle: max once per 5 seconds even if socket fires rapidly
    
    const onWalletUpdate = () => {
      const now = Date.now();
      if (now - lastFetchTime < MIN_FETCH_INTERVAL) return;
      lastFetchTime = now;
      fetchWalletBalancesRef.current();
    };
    
    try { effectiveSocket.on('wallet-update', onWalletUpdate); } catch {}
    
    return () => {
      try { effectiveSocket.off('wallet-update', onWalletUpdate); } catch {}
    };
  }, [effectiveSocket]); // Removed fetchWalletBalances from deps to prevent effect re-runs

  // Subscribe to backend-bridged opportunities stream
  // Throttle opportunities updates with reduced latency for critical updates (200ms for summary, 100ms for critical signals)
  useEffect(() => {
    if (!effectiveSocket) return;
    let lastAt = 0;
    let lastSig = '';
    const buildSignature = (payload: { items?: Opportunity[]; summary?: OpportunitiesSummary } | undefined) => {
      try {
        const items = Array.isArray(payload?.items) ? (payload?.items as Opportunity[]) : [];
        const itemsSig = items
          .map((o) => {
            const path = Array.isArray(o?.path) ? o.path.join('>') : '';
            const profit = o?.profit_bps ?? '';
            const net = o?.net_bps ?? o?.profit_bps ?? '';
            const detected = o?.detected_ms ?? '';
            const lastVerified = (o as any)?.last_verified_ms ?? '';
            const firstSeen = o?.first_seen_ms ?? '';
            const capacity = o?.est_capacity ?? '';
            return `${path}:${profit}:${net}:${detected}:${lastVerified}:${firstSeen}:${capacity}`;
          })
          .join('|');

        const summary = payload?.summary;
        const nearSig = summary?.near_miss
          ? `${(summary.near_miss.path || []).join('>')}:${summary.near_miss.profit_bps}:${summary.near_miss.net_bps ?? summary.near_miss.profit_bps}:${summary.near_miss_shortfall_bps ?? ''}:${summary.near_miss.detected_ms ?? ''}`
          : '';
        const nearList = Array.isArray(summary?.near_misses) ? (summary?.near_misses as Opportunity[]) : [];
        const nearListSig = nearList
          .map((nm) => `${(nm.path || []).join('>')}:${nm.profit_bps}:${nm.net_bps ?? nm.profit_bps}:${nm.detected_ms ?? ''}`)
          .join('|');
        const summaryMarkers = [
          summary?.count ?? '',
          summary?.last_detection_ms ?? '',
          summary?.detection_duration_ms ?? '',
          summary?.graph_nodes ?? '',
          summary?.graph_edges ?? '',
          summary?.near_miss_shortfall_bps ?? '',
        ].join(':');
        const rejected = summary?.rejected_opportunities;
        const rejectedSig = Array.isArray(rejected)
          ? rejected.map((rej) => {
              const path = Array.isArray(rej.path) ? rej.path.join('>') : '';
              const rateSig = Array.isArray(rej.hop_rates) ? rej.hop_rates.map((r) => Number.isFinite(r) ? Number(r).toFixed(6) : String(r)).join(',') : '';
              const poolSig = Array.isArray(rej.hop_pool_ids) ? rej.hop_pool_ids.join(',') : '';
              return `${rej.reason}:${path}:${rej.profit_bps ?? ''}:${rej.net_bps ?? ''}:${rej.hop_count ?? ''}:${rateSig}:${poolSig}`;
            }).join('|')
          : '';

        return `${itemsSig}||${nearSig}||${nearListSig}||${summaryMarkers}||${rejectedSig}`;
      } catch {
        return String(Date.now());
      }
    };
    const applyBulk = (payload: { items?: Opportunity[]; summary?: OpportunitiesSummary }, isCritical = false) => {
      try {
        const now = Date.now();
        const throttleMs = isCritical ? 100 : 200; // Reduced from 1000ms
        if (now - lastAt < throttleMs) return;
        const sig = buildSignature(payload);
        if (sig === lastSig) return;
        lastSig = sig;
        lastAt = now;
        const updateFn = () => {
          if (Array.isArray(payload?.items)) setItems(payload.items as Opportunity[]);
          if (payload && typeof payload === 'object' && 'summary' in payload) setSummary((payload as any).summary || null);
        };
        if (isCritical) {
          enqueueCritical(updateFn);
        } else {
          enqueueFrame(updateFn);
        }
      } catch {}
    };
    const onOpps = (payload: { items?: Opportunity[]; summary?: OpportunitiesSummary }) => { 
      // Check if update is critical (new opportunities detected)
      const hasNewOpps = Array.isArray(payload?.items) && payload.items.length > 0;
      applyBulk(payload, hasNewOpps); 
      try { requestExecStats(); } catch {} 
    };
    // Optional: critical fast-path if backend emits "arb:signal"; fallback derives from bulk head
    const onSignal = (sig: { items?: Opportunity[] }) => {
      try {
        const head = Array.isArray(sig?.items) ? (sig.items as Opportunity[]).slice(0, 3) : [];
        if (!head.length) return;
        enqueueCritical(() => {
          // Update minimal, cheap critical state for immediate visibility
          setCriticalTop(head);
          setSummary((prev) => (prev ? { ...prev, last_detection_ms: Date.now() } as any : prev));
        });
      } catch {}
    };
    const requestExecStats = throttle(async () => {
      try {
        const r = await fetch(`${apiBase}/arb/metrics/json`);
        const j = await r.json();
        setExecStats(j?.exec || null);
        setArbMetrics(j || null);
      } catch {}
    }, 2000);
    try { effectiveSocket.on('arb:opportunities', onOpps); } catch {}
    try { effectiveSocket.on('arb:signal', onSignal); } catch {}
    return () => {
      try { effectiveSocket.off('arb:opportunities', onOpps); } catch {}
      try { effectiveSocket.off('arb:signal', onSignal); } catch {}
    };
  }, [effectiveSocket]);

  // Auto-highlight current near-miss on graph to visualize triangles for diagnostics
  useEffect(() => {
    try {
      const nm: any = summary?.near_miss as any;
      if (!nm) return;
      const ids: string[] | undefined = nm?.hop_pool_ids;
      if (ids && ids.length) {
        try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { edgeIds: ids } })); } catch {}
        if (effectiveSocket) { try { effectiveSocket.emit('graph-highlight', { edgeIds: ids }); } catch {} }
        return;
      }
      const pathArr: string[] = Array.isArray(nm?.path) ? nm.path : [];
      const hops: string[] = Array.isArray(nm?.hop_dexes) ? nm.hop_dexes : [];
      if (pathArr.length > 1) {
        const pairs: Array<{ source: string; target: string; dex?: string }> = [];
        for (let i = 0; i < pathArr.length - 1; i++) {
          pairs.push({ source: pathArr[i], target: pathArr[i+1], dex: hops[i % (hops.length || 1)] });
        }
        try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { pairs } })); } catch {}
        if (effectiveSocket) { try { effectiveSocket.emit('graph-highlight', { pairs }); } catch {} }
      }
    } catch {}
  }, [summary?.near_miss, effectiveSocket]);
  useEffect(() => {
    if (!effectiveSocket) return;
    const onTxAny = async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); const allItems = Array.isArray(j?.items) ? j.items : []; setTxRows(allItems.slice(0, 10)); } catch {}
    };
    effectiveSocket.on('tx:start', onTxAny);
    effectiveSocket.on('tx:resolved', onTxAny);
    effectiveSocket.on('tx:sim.ok', onTxAny);
    effectiveSocket.on('tx:sim.err', onTxAny);
    effectiveSocket.on('tx:send.ok', onTxAny);
    effectiveSocket.on('tx:send.err', onTxAny);
    effectiveSocket.on('tx:history.updated', onTxAny);
    return () => {
      effectiveSocket.off('tx:start', onTxAny);
      effectiveSocket.off('tx:resolved', onTxAny);
      effectiveSocket.off('tx:sim.ok', onTxAny);
      effectiveSocket.off('tx:sim.err', onTxAny);
      effectiveSocket.off('tx:send.ok', onTxAny);
      effectiveSocket.off('tx:send.err', onTxAny);
      effectiveSocket.off('tx:history.updated', onTxAny);
    };
  }, [effectiveSocket]);

  // Remove periodic polling; rely on socket-driven refreshes

  return (
    <div className="p-2 border rounded bg-white/5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">Arbitrage Opportunities</h3>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 border rounded" onClick={()=>{ try { (window as any).dispatchEvent(new CustomEvent('open-graph-config')); } catch {} }}>Graph Config</button>
          {onOpenExecConfig && <button className="px-2 py-1 border rounded" onClick={onOpenExecConfig}>Exec Config</button>}
          <button className="px-2 py-1 border rounded" onClick={async()=>{
            try { await fetch(`${apiBase}${ROUTES.arb.metricsJson}`, { headers: { 'accept': 'application/json' } }); } catch {}
            // Best-effort also refresh opportunities snapshot
            try { await fetchOpps(); } catch {}
          }}>Refresh Metrics</button>
          <button className="px-2 py-1 border rounded" onClick={onToggleGraph} title="Toggle Graph Visualizer">{showGraph ? 'Hide Graph' : 'Show Graph'}</button>
          {loading ? <span className="text-xs opacity-70 animate-pulse">Refreshing…</span> : null}
        </div>
      </div>
      {error && <div className="text-red-400 text-sm mb-2">{error}</div>}
      {/* Summary block */}
      <div className="mb-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Active Opps</div>
            <div className="text-sm">{fmt(summary?.count)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Detection Cycles</div>
            <div className="text-sm">{fmt((arbMetrics as any)?.detection_cycles_total)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Opps Detected (total)</div>
            <div className="text-sm">{fmt((arbMetrics as any)?.opportunities_detected_total)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Detector Hit Rate</div>
            <div className="text-sm">
              {(() => { try {
                const hits = Number((arbMetrics as any)?.detection_hits_total || 0);
                const misses = Number((arbMetrics as any)?.detection_misses_total || 0);
                const total = hits + misses;
                return total ? `${Math.round((100*hits)/total)}%` : '—';
              } catch { return '—'; } })()}
            </div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Preflight Success</div>
            <div className="text-sm">
              {(() => { try {
                const ok = Number((execStats as any)?.counts?.preflight_ok || 0);
                const er = Number((execStats as any)?.counts?.preflight_err || 0);
                const t = ok + er;
                return t ? `${Math.round((100*ok)/t)}% (${fmt(ok)}/${fmt(t)})` : '—';
              } catch { return '—'; } })()}
            </div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Transactions Sent</div>
            <div className="text-sm">{(() => { try { const ok = Number((execStats as any)?.counts?.send_ok || 0); const er = Number((execStats as any)?.counts?.send_err || 0); return fmt(ok + er);} catch { return '—'; } })()}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Send Success</div>
            <div className="text-sm">
              {(() => { try {
                const ok = Number((execStats as any)?.counts?.send_ok || 0);
                const er = Number((execStats as any)?.counts?.send_err || 0);
                const t = ok + er;
                return t ? `${Math.round((100*ok)/t)}% (${fmt(ok)}/${fmt(t)})` : '—';
              } catch { return '—'; } })()}
            </div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Tx Coverage</div>
            <div className="text-sm">
              {(() => { try {
                const ok = Number((execStats as any)?.counts?.send_ok || 0);
                const er = Number((execStats as any)?.counts?.send_err || 0);
                const sent = ok + er;
                const opps = Number((arbMetrics as any)?.opportunities_detected_total || 0);
                return (opps > 0) ? (sent / opps).toFixed(2) : '—';
              } catch { return '—'; } })()}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] mt-2 opacity-80">
          <div>Last Detection: {age(summary?.last_detection_ms)}</div>
          <div>Detect Ms: {fmt(summary?.detection_duration_ms)}</div>
          <div>Diff→Detect Ms: {fmt((summary as any)?.diff_to_detect_ms)}</div>
          <div>Graph: {fmt(summary?.graph_nodes)} nodes / {fmt(summary?.graph_edges)} edges</div>
          <div>Tx Build Ms: {fmt((execStats as any)?.build_ms?.p50)} p50 · {fmt((execStats as any)?.build_ms?.p95)} p95</div>
          <div>Send Ms: {fmt((execStats as any)?.send_ms?.p50)} p50 · {fmt((execStats as any)?.send_ms?.p95)} p95</div>
        </div>
      </div>
      {/* Critical top opportunities strip (fast path) */}
      {criticalTop.length > 0 && (
        <div className="mb-3 border rounded bg-emerald-900/15 p-2 text-xs">
          <div className="font-semibold mb-1">Top Opportunities (live)</div>
          <div className="flex flex-col gap-1">
            {criticalTop.map((op, i) => (
              <div key={`${(op.path||[]).join('>')}|${i}`} className="flex items-center gap-2">
                <div className="px-1 py-0.5 rounded bg-black/20">#{i+1}</div>
                <div className="font-mono truncate" title={(op.path||[]).join(' -> ')}>{(op.path||[]).map(sym).join(' → ')}</div>
                <div className="ml-auto opacity-80">Net {fmtPctFromBps(op.net_bps ?? op.profit_bps)} · ${fmt(op.est_profit_usd, 2)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Executor Control */}
      <ExecutorControl apiBase={apiBase} socket={effectiveSocket} />

      {items.length === 0 && summary?.near_miss && !firstLoad && (
        <div className="p-2 border rounded bg-yellow-900/20 text-xs mb-3">
          <div className="font-semibold mb-1">Closest Path (below threshold by {fmt(summary?.near_miss_shortfall_bps)} bps)</div>
          <div className="font-mono mb-1">
            {(() => {
              const hops = summary.near_miss?.hop_dexes || [];
              const rates = summary.near_miss?.hop_rates || [];
              // Derive amounts from hop_rates for display; ignore hop_outs to avoid scale confusion
              const outs: number[] | undefined = undefined;
              const fees = (summary.near_miss as any)?.hop_fee_bps as number[] | undefined;
              const liqs = (summary.near_miss as any)?.hop_liquidity_display as number[] | undefined;
              const startMint = summary.near_miss?.path?.[0];
              const pathArr = summary.near_miss.path || [];
              const edgesCount = Math.max(0, pathArr.length - 1);
              const showClosing = Array.isArray(rates) && rates.length > edgesCount;
              let amt = startMint === quoteSizeMint ? quoteSize : 1.0; // seed
              const pieces: React.ReactNode[] = [];
              // forward edges
              for (let i = 0; i < pathArr.length; i++) {
                const m = pathArr[i];
                const sym = tokenMap[m] || (m.length > 6 ? `${m.slice(0,4)}…${m.slice(-4)}` : m);
                const dex = hops[i % (hops.length || 1)];
                const color = dex === 'Raydium' ? 'text-green-400' : (dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
                const rate = Number.isFinite(rates[i % (rates.length || 1)]) ? rates[i % (rates.length || 1)] : undefined;
                const fee = fees && Number.isFinite(fees[i % fees.length] as any) ? fees[i % fees.length] : undefined;
                const liq = liqs && Number.isFinite(liqs[i % liqs.length] as any) ? liqs[i % liqs.length] : undefined;
                const out = undefined;
                pieces.push(
                  <span key={`${m}-${i}`}>
                    <span className="font-semibold">{sym}</span>{i===0?` (${amt.toFixed(4)})`:''}
                    {i < pathArr.length - 1 && (
                      <span>
                        {' '}
                        <span className={`px-1 rounded ${color}`}>
                          {dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{rate ? ` · ×${rate.toFixed(4)} → ${(amt * rate).toFixed(4)}` : ''}
                        </span>
                        {' '}→{' '}
                      </span>
                    )}
                  </span>
                );
                if (i < pathArr.length - 1) {
                  if (rate) amt = amt * rate;
                }
              }
              // closing hop to first (if present)
              if (showClosing) {
                const i = edgesCount; // index for closing rate/dex
                const last = pathArr[pathArr.length - 1];
                const first = pathArr[0];
                const dex = hops[i % (hops.length || 1)];
                const color = dex === 'Raydium' ? 'text-green-400' : (dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
                const rate = Number.isFinite(rates[i]) ? rates[i] : undefined;
                const fee = fees && Number.isFinite(fees[i] as any) ? fees[i] : undefined;
                const liq = liqs && Number.isFinite(liqs[i] as any) ? liqs[i] : undefined;
                const out = undefined;
                pieces.push(
                  <span key={`${last}-close`}>
                    <span className="font-semibold">{tokenMap[last] || (last.length > 6 ? `${last.slice(0,4)}…${last.slice(-4)}` : last)}</span>
                    <span> <span className={`px-1 rounded ${color}`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{rate ? ` · ×${rate.toFixed(4)} → ${(amt * (rate as number)).toFixed(4)}` : ''}</span> → </span>
                    <span className="font-semibold">{tokenMap[first] || (first.length > 6 ? `${first.slice(0,4)}…${first.slice(-4)}` : first)}</span>
                  </span>
                );
              }
              return pieces;
            })()}
          </div>
          <div className="mt-1">
            <button className="px-2 py-1 border rounded" onClick={()=>{
              try {
                const nm: any = summary?.near_miss as any;
                const ids = (nm)?.hop_pool_ids as string[] | undefined;
                if (ids && ids.length) {
                  try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { edgeIds: ids } })); } catch {}
                  if (socket) { try { socket.emit('graph-highlight', { edgeIds: ids }); } catch {} }
                  return;
                }
                // Fallback: construct selectors from path + hop_dexes
                const pathArr: string[] = Array.isArray(nm?.path) ? nm.path : [];
                const hops: string[] = Array.isArray(nm?.hop_dexes) ? nm.hop_dexes : [];
                const pairs: Array<{ source: string; target: string; dex?: string }> = [];
                for (let i = 0; i < pathArr.length - 1; i++) {
                  const source = pathArr[i];
                  const target = pathArr[i+1];
                  const dex = hops[i % (hops.length || 1)];
                  pairs.push({ source, target, dex });
                }
                if (pairs.length) {
                  try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { pairs } })); } catch {}
                  if (socket) { try { socket.emit('graph-highlight', { pairs }); } catch {} }
                }
              } catch {}
            }}>Highlight in graph</button>
          </div>
          <div>Profit: {fmtPctFromBps(summary.near_miss.profit_bps)} · Net: {fmtPctFromBps(summary.near_miss.net_bps || summary.near_miss.profit_bps)}</div>
          <div>Hops: {summary.near_miss.hop_count ?? summary.near_miss.path.length} · Links: {summary.near_miss.link_edges_used ?? 0} · Min Edge Liq: {fmt(summary.near_miss.min_edge_liquidity, 2)}</div>
          {summary.near_miss.bottleneck && (() => {
            const b = summary.near_miss!.bottleneck!;
            const fromSym = tokenMap[b.from] || (b.from.length > 6 ? `${b.from.slice(0,4)}…${b.from.slice(-4)}` : b.from);
            const toSym = tokenMap[b.to] || (b.to.length > 6 ? `${b.to.slice(0,4)}…${b.to.slice(-4)}` : b.to);
            const color = b.dex === 'Raydium' ? 'text-green-400' : (b.dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
            return (
              <div>
                Bottleneck: <span className={`px-1 rounded ${color}`}>{b.dex}</span> {fromSym} → {toSym} · rate {fmt(b.rate, 6)} · liq {fmt(b.liquidity, 2)}
              </div>
            );
          })()}
          <div className="mt-2 flex items-center gap-2">
            <label className="text-[11px] opacity-80">Quote:</label>
            <input className="px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-white w-24" type="number" step={0.0001} value={sendAmount} onChange={e=>setSendAmount(parseFloat(e.target.value)||0)} />
            <select className="px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-white" value={sendMode} onChange={e=>setSendMode(e.target.value as any)}>
              <option value="USD">USD</option>
              <option value="TOKENS">Tokens</option>
            </select>
            {(() => {
              const nm: any = summary?.near_miss as any;
              const hopIds = ((nm?.hop_pool_ids || []) as string[]);
              const hopDexes = ((nm?.hop_dexes || []) as string[]);
              const expectedHops = Math.max(0, ((nm?.hop_count ?? nm?.path?.length) || 0));
              const validHops = expectedHops > 0 && hopIds.length === expectedHops && hopDexes.length === expectedHops;
              const pathClosed = Array.isArray(nm?.path) && nm.path.length ? [...nm.path, nm.path[0]] : nm?.path;
              return (
                <>
                  <button className={`px-2 py-1 border rounded ${sending?'opacity-60':''}`} disabled={sending || !validHops} title={!validHops ? `Invalid hops: expected ${expectedHops}, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length}` : undefined} onClick={async ()=>{
                    if (!summary?.near_miss?.path?.length || !validHops) return;
                    setSending(true);
                    try {
                      const body: any = { path: pathClosed, hopPoolIds: hopIds, dexes: hopDexes };
                      if (sendMode === 'USD') body.sizeUsd = Number(sendAmount)||0; else body.size = Number(sendAmount)||0;
                      setNmSimLogs(null); setNmSimErr(null);
                      const r = await fetch(`${apiBase}${ROUTES.arb.simulateSend}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                      const j = await r.json().catch(()=>({}));
                      if (!r.ok) {
                        setNmSimErr(String((j && (j.error || j.err)) || 'preflight_failed'));
                      } else {
                        const logs = Array.isArray(j?.logs) ? (j.logs as string[]) : [];
                        setNmSimLogs(logs.slice(-20));
                        setNmSimErr(j?.err ? String(j.err) : null);
                      }
                      try { const rh = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const jh = await rh.json(); const allItems = Array.isArray(jh?.items) ? jh.items : []; setTxRows(allItems.slice(0, 10)); } catch {}
                    } catch {}
                    setSending(false);
                  }}>Preflight Simulate</button>
                  <button className={`px-2 py-1 border rounded ${sending?'opacity-60':''}`} disabled={sending || !validHops} title={!validHops ? `Invalid hops: expected ${expectedHops}, got hopPoolIds=${hopIds.length}, hopDexes=${hopDexes.length}` : undefined} onClick={async ()=>{
                    if (!summary?.near_miss?.path?.length || !validHops) return;
                    setSending(true);
                    try {
                      const body: any = { path: pathClosed, hopPoolIds: hopIds, dexes: hopDexes };
                      if (sendMode === 'USD') body.sizeUsd = Number(sendAmount)||0; else body.size = Number(sendAmount)||0;
                      body.forceDirect = true;
                      setNmSimLogs(null); setNmSimErr(null);
                      const r = await fetch(`${apiBase}${ROUTES.arb.execute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                      const j = await r.json().catch(()=>({}));
                      if (!r.ok) {
                        setNmSimErr(String((j && (j.error || j.err)) || 'send_failed'));
                      } else if (j && j.mode && j.mode !== 'direct' && j.mode !== 'simulate_then_execute') {
                        setNmSimErr(`Execution disabled (mode: ${j.mode}). Enable 'direct' or 'simulate → execute' in Exec Config.`);
                      }
                      try { const rh = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const jh = await rh.json(); const allItems = Array.isArray(jh?.items) ? jh.items : []; setTxRows(allItems.slice(0, 10)); } catch {}
                    } catch (e: any) {
                      setNmSimErr(String(e?.message || e));
                    }
                    setSending(false);
                  }}>Execute Direct</button>
                  <button className={`px-2 py-1 border rounded ${sending?'opacity-60':''}`} disabled={sending || !summary?.near_miss?.path?.length} onClick={async ()=>{
                    if (!summary?.near_miss?.path?.length) return;
                    setSending(true);
                    try {
                      const body: any = { path: pathClosed };
                      if (sendMode === 'USD') body.sizeUsd = Number(sendAmount)||0; else body.size = Number(sendAmount)||0;
                      body.hopDexes = Array.isArray(nm?.hop_dexes) ? nm.hop_dexes : [];
                      body.strictMinOut = true;
                      const r = await fetch(`${apiBase}${ROUTES.arb.jupiterExecute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                      const j = await r.json().catch(()=>({}));
                      if (!r.ok) setNmSimErr(String((j && (j.error || j.err)) || 'send_failed'));
                    } catch (e: any) {
                      setNmSimErr(String(e?.message || e));
                    }
                    setSending(false);
                  }}>Execute via Jupiter (strict)</button>
                </>
              );
            })()}
          </div>
          {(nmSimErr || (nmSimLogs && nmSimLogs.length)) && (
            <div className="mt-1 p-2 bg-black/30 rounded text-[11px]">
              {nmSimErr && <div className="text-red-400">Preflight error: {nmSimErr}</div>}
              {nmSimLogs && nmSimLogs.length > 0 && (
                <pre className="whitespace-pre-wrap break-words opacity-80">
                  {nmSimLogs.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      {items.length === 0 && summary?.near_misses && summary.near_misses.length > 0 && (
        <div className="p-2 border rounded bg-yellow-900/10 text-xs mb-3">
          <div className="font-semibold mb-1">Near-misses this run</div>
          <div className="space-y-1">
            {summary.near_misses.slice(0, 10).map((nm, i) => (
              <div key={i} className="font-mono">
                <div className="mb-0.5">{(nm.path || []).map(m => tokenMap[m] || (m.length > 6 ? `${m.slice(0,4)}…${m.slice(-4)}` : m)).join(' → ')}</div>
                <div>Profit: {fmtPctFromBps(nm.profit_bps)} · Net: {fmtPctFromBps((nm as any).net_bps || nm.profit_bps)} · Hops: {nm.hop_count ?? nm.path.length}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {rejectedDebug.length > 0 && (
        <div className="p-2 border rounded bg-red-900/10 text-xs mb-3">
          <div className="font-semibold mb-1">Rejected Opportunities (debug)</div>
          <div className="space-y-1">
            {rejectedDebug.map((rej, i) => (
              <div key={`${rej.reason}:${(rej.path || []).join('>')}:${i}`} className="font-mono space-y-1">
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className="px-1 py-0.5 rounded bg-red-900/40 text-red-100 uppercase tracking-wide">{formatRejectedReason(rej.reason)}</span>
                  {typeof rej.hop_count === 'number' && <span>Hops: {rej.hop_count}</span>}
                  {typeof rej.profit_bps === 'number' && <span>Profit: {fmtPctFromBps(rej.profit_bps)}</span>}
                  {typeof rej.net_bps === 'number' && rej.net_bps !== rej.profit_bps && <span>Net: {fmtPctFromBps(rej.net_bps)}</span>}
                </div>
                <div>{(rej.path || []).map(sym).join(' → ') || '—'}</div>
                {Array.isArray(rej.dexes) && rej.dexes.length > 0 && (
                  <div className="text-[11px] opacity-80">Dexes: {rej.dexes.join(', ')}</div>
                )}
                {(() => {
                  const pathArr = Array.isArray(rej.path) ? rej.path : [];
                  if (pathArr.length <= 1) return null;
                  return (
                    <div className="space-y-0.5 text-[11px] opacity-80">
                      {pathArr.slice(0, -1).map((mint, idx) => {
                        const next = pathArr[idx + 1];
                        const dex = rej.hop_dexes?.[idx];
                        const rate = rej.hop_rates?.[idx];
                        const out = rej.hop_outs?.[idx];
                        const pool = rej.hop_pool_ids?.[idx];
                        const poolLabel = pool ? (pool.length > 10 ? `${pool.slice(0,4)}…${pool.slice(-4)}` : pool) : null;
                        return (
                          <div key={`${mint}->${next}:${idx}`} className="flex flex-wrap gap-2">
                            <span className="font-semibold">{sym(mint)} → {sym(next)}</span>
                            {dex && <span>{dex}</span>}
                            {typeof rate === 'number' && isFinite(rate) && <span>rate {rate.toFixed(6)}</span>}
                            {typeof out === 'number' && isFinite(out) && <span>out {fmt(out, 4)}</span>}
                            {poolLabel && <span>pool {poolLabel}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}
      {items.length === 0 && !firstLoad && (!summary?.near_misses || summary.near_misses.length === 0) && <div className="text-sm opacity-70">No opportunities</div>}
      <OpportunityList
        items={items}
        tokenMap={tokenMap}
        quoteSize={quoteSize}
        quoteSizeMint={quoteSizeMint}
        sendMode={sendMode}
        sendAmount={sendAmount}
        apiBase={apiBase}
        socket={effectiveSocket}
        walletBalances={walletBalances}
      />
      <div className="mt-4 p-2 border rounded bg-black/10">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold">Transactions</h4>
          <button className="px-2 py-1 border rounded" onClick={async()=>{ try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); const allItems = Array.isArray(j?.items) ? j.items : []; setTxRows(allItems.slice(0, 10)); } catch {} }}>Refresh</button>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left opacity-70">
                <th className="py-1 pr-2">Time</th>
                <th className="py-1 pr-2">Path</th>
                <th className="py-1 pr-2">Hops</th>
                <th className="py-1 pr-2">Ix</th>
                <th className="py-1 pr-2">Bytes</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Sig</th>
                <th className="py-1 pr-2">Log</th>
              </tr>
            </thead>
            <tbody>
              {txRows.map((r) => {
                const rowKey = `${r.id}:${r.status}:${r.timeMs}`;
                return (
                <>
                  <tr key={rowKey} className="border-t border-white/10 cursor-pointer" onClick={()=> setExpandedKey(expandedKey===rowKey?null:rowKey)}>
                    <td className="py-1 pr-2">{new Date(r.timeMs).toLocaleTimeString()}</td>
                    <td className="py-1 pr-2 font-mono">{(r.path||[]).map(sym).join(' → ')}</td>
                    <td className="py-1 pr-2">{r.hops.map((h, i) => `${sym(r.path[i])}→${sym(r.path[i+1])} (${h.dex}/${h.variant})`).join(', ')}</td>
                    <td className="py-1 pr-2">{r.ixCount}</td>
                    <td className="py-1 pr-2">{r.txSizeBytes}</td>
                    <td className="py-1 pr-2">{r.status}</td>
                    <td className="py-1 pr-2">{r.signature ? <a className="text-blue-400 underline" href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer">{r.signature.slice(0,6)}…</a> : '—'}</td>
                    <td className="py-1 pr-2">{r.logFile ? <a className="text-purple-400 hover:text-purple-300 underline" href={`https://files.mccurrach.xyz/files/lockstone-dev/backend/logs/execution-attempts/${r.logFile}`} target="_blank" rel="noreferrer" title={r.logFile}>📋</a> : '—'}</td>
                  </tr>
                  {expandedKey === rowKey && (
                    <tr key={`${rowKey}-exp`} className="bg-black/20">
                      <td colSpan={8} className="py-2 px-2">
                        <div className="text-[11px] grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <div className="font-semibold mb-1">Hops</div>
                            <div className="space-y-1">
                              {r.hops.map((h, i) => (
                                <div key={i} className="font-mono">{i+1}. {sym(r.path[i])} → {sym(r.path[i+1])} · {h.dex}/{h.variant} · pool {h.poolId}</div>
                              ))}
                            </div>
                          </div>
                          <div className="opacity-80">
                            <div className="font-semibold mb-1">Details</div>
                            <div>Ix Count: {r.ixCount} · Size: {r.txSizeBytes} bytes · Status: {r.status}</div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )})}
              {txRows.length === 0 && (
                <tr><td className="py-2 opacity-70" colSpan={8}>No transactions</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};


