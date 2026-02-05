import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocket } from '../app/contexts/socket';
import OpportunityList from './OpportunityList';
import { enqueueCritical, enqueueFrame, throttle } from '../utils/scheduler';
import { ExecutorControl } from './ExecutorControl';
import { Panel, StatCard, Button, DataTable, DataTableRow, DataTableCell, EmptyState, Input, Select } from './ui';

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
  const [quoteSizeMint, setQuoteSizeMint] = useState<string>('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
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
      setWalletBalances(null);
    }
  }, [apiBase]);

  const fetchWalletBalancesRef = useRef(fetchWalletBalances);
  useEffect(() => {
    fetchWalletBalancesRef.current = fetchWalletBalances;
  }, [fetchWalletBalances]);

  const [lastDetectionTs, setLastDetectionTs] = useState<number>(0);
  useEffect(() => {
    fetchOpps();
    fetchTokenMap();
    fetchWalletBalances();
    (async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.config}`); const j = await r.json(); if (typeof j?.quote_size_usd === 'number') setQuoteSize(Number(j.quote_size_usd)||50); } catch {}
    })();
    (async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); const allItems = Array.isArray(j?.items) ? j.items : []; setTxRows(allItems.slice(0, 10)); } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!effectiveSocket) return;
    let lastFetchTime = 0;
    const MIN_FETCH_INTERVAL = 5000;
    
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
  }, [effectiveSocket]);

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
        const throttleMs = isCritical ? 100 : 200;
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
      const hasNewOpps = Array.isArray(payload?.items) && payload.items.length > 0;
      applyBulk(payload, hasNewOpps); 
      try { requestExecStats(); } catch {} 
    };
    const onSignal = (sig: { items?: Opportunity[] }) => {
      try {
        const head = Array.isArray(sig?.items) ? (sig.items as Opportunity[]).slice(0, 3) : [];
        if (!head.length) return;
        enqueueCritical(() => {
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

  return (
    <Panel
      title="Arbitrage Opportunities"
      actions={
        <div className="flex items-center gap-2">
          <Button onClick={()=>{ try { (window as any).dispatchEvent(new CustomEvent('open-graph-config')); } catch {} }}>
            Graph Config
          </Button>
          {onOpenExecConfig && <Button onClick={onOpenExecConfig}>Exec Config</Button>}
          <Button onClick={async()=>{
            try { await fetch(`${apiBase}${ROUTES.arb.metricsJson}`, { headers: { 'accept': 'application/json' } }); } catch {}
            try { await fetchOpps(); } catch {}
          }}>Refresh Metrics</Button>
          <Button onClick={onToggleGraph}>{showGraph ? 'Hide Graph' : 'Show Graph'}</Button>
          {loading && <span className="text-xs text-gray-400 animate-pulse">Refreshing…</span>}
        </div>
      }
    >
      {error && <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>}
      
      {/* Summary Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="Active Opps" value={fmt(summary?.count)} />
        <StatCard label="Detection Cycles" value={fmt((arbMetrics as any)?.detection_cycles_total)} />
        <StatCard label="Opps Detected" value={fmt((arbMetrics as any)?.opportunities_detected_total)} />
        <StatCard 
          label="Detector Hit Rate" 
          value={(() => { 
            try {
              const hits = Number((arbMetrics as any)?.detection_hits_total || 0);
              const misses = Number((arbMetrics as any)?.detection_misses_total || 0);
              const total = hits + misses;
              return total ? `${Math.round((100*hits)/total)}%` : '—';
            } catch { return '—'; } 
          })()} 
        />
        <StatCard 
          label="Preflight Success" 
          value={(() => { 
            try {
              const ok = Number((execStats as any)?.counts?.preflight_ok || 0);
              const er = Number((execStats as any)?.counts?.preflight_err || 0);
              const t = ok + er;
              return t ? `${Math.round((100*ok)/t)}%` : '—';
            } catch { return '—'; } 
          })()} 
          subValue={(() => { 
            try {
              const ok = Number((execStats as any)?.counts?.preflight_ok || 0);
              const er = Number((execStats as any)?.counts?.preflight_err || 0);
              return `${fmt(ok)}/${fmt(ok + er)}`;
            } catch { return ''; } 
          })()}
        />
        <StatCard 
          label="Transactions Sent" 
          value={(() => { 
            try { 
              const ok = Number((execStats as any)?.counts?.send_ok || 0); 
              const er = Number((execStats as any)?.counts?.send_err || 0); 
              return fmt(ok + er);
            } catch { return '—'; } 
          })()} 
        />
        <StatCard 
          label="Send Success" 
          value={(() => { 
            try {
              const ok = Number((execStats as any)?.counts?.send_ok || 0);
              const er = Number((execStats as any)?.counts?.send_err || 0);
              const t = ok + er;
              return t ? `${Math.round((100*ok)/t)}%` : '—';
            } catch { return '—'; } 
          })()} 
          subValue={(() => { 
            try {
              const ok = Number((execStats as any)?.counts?.send_ok || 0);
              const er = Number((execStats as any)?.counts?.send_err || 0);
              return `${fmt(ok)}/${fmt(ok + er)}`;
            } catch { return ''; } 
          })()}
        />
        <StatCard 
          label="Tx Coverage" 
          value={(() => { 
            try {
              const ok = Number((execStats as any)?.counts?.send_ok || 0);
              const er = Number((execStats as any)?.counts?.send_err || 0);
              const sent = ok + er;
              const opps = Number((arbMetrics as any)?.opportunities_detected_total || 0);
              return (opps > 0) ? (sent / opps).toFixed(2) : '—';
            } catch { return '—'; } 
          })()} 
        />
      </div>

      {/* Timing Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs text-gray-400 mb-4 p-3 bg-gray-900/50 rounded-lg">
        <div>Last Detection: <span className="text-white">{age(summary?.last_detection_ms)}</span></div>
        <div>Detect Ms: <span className="text-white">{fmt(summary?.detection_duration_ms)}</span></div>
        <div>Diff→Detect Ms: <span className="text-white">{fmt((summary as any)?.diff_to_detect_ms)}</span></div>
        <div>Graph: <span className="text-white">{fmt(summary?.graph_nodes)} nodes / {fmt(summary?.graph_edges)} edges</span></div>
        <div>Tx Build Ms: <span className="text-white">{fmt((execStats as any)?.build_ms?.p50)} p50 · {fmt((execStats as any)?.build_ms?.p95)} p95</span></div>
        <div>Send Ms: <span className="text-white">{fmt((execStats as any)?.send_ms?.p50)} p50 · {fmt((execStats as any)?.send_ms?.p95)} p95</span></div>
      </div>

      {/* Critical Top Opportunities */}
      {criticalTop.length > 0 && (
        <div className="mb-4 p-3 bg-emerald-900/20 border border-emerald-700/50 rounded-lg">
          <div className="text-sm font-semibold text-emerald-400 mb-2">Top Opportunities (live)</div>
          <div className="space-y-1">
            {criticalTop.map((op, i) => (
              <div key={`${(op.path||[]).join('>')}|${i}`} className="flex items-center gap-3 text-sm">
                <span className="px-2 py-0.5 bg-emerald-900/50 rounded text-emerald-400 text-xs font-mono">#{i+1}</span>
                <span className="font-mono text-gray-300 truncate" title={(op.path||[]).join(' -> ')}>{(op.path||[]).map(sym).join(' → ')}</span>
                <span className="ml-auto text-gray-400">Net {fmtPctFromBps(op.net_bps ?? op.profit_bps)} · <span className="text-green-400">${fmt(op.est_profit_usd, 2)}</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Executor Control */}
      <div className="mb-4">
        <ExecutorControl apiBase={apiBase} socket={effectiveSocket} />
      </div>

      {/* Near Miss */}
      {items.length === 0 && summary?.near_miss && !firstLoad && (
        <div className="mb-4 p-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg">
          <div className="text-sm font-semibold text-yellow-400 mb-2">
            Closest Path (below threshold by {fmt(summary?.near_miss_shortfall_bps)} bps)
          </div>
          <div className="font-mono text-sm text-gray-300 mb-3">
            {(() => {
              const hops = summary.near_miss?.hop_dexes || [];
              const rates = summary.near_miss?.hop_rates || [];
              const fees = (summary.near_miss as any)?.hop_fee_bps as number[] | undefined;
              const liqs = (summary.near_miss as any)?.hop_liquidity_display as number[] | undefined;
              const startMint = summary.near_miss?.path?.[0];
              const pathArr = summary.near_miss.path || [];
              const edgesCount = Math.max(0, pathArr.length - 1);
              const showClosing = Array.isArray(rates) && rates.length > edgesCount;
              let amt = startMint === quoteSizeMint ? quoteSize : 1.0;
              const pieces: React.ReactNode[] = [];
              for (let i = 0; i < pathArr.length; i++) {
                const m = pathArr[i];
                const symName = tokenMap[m] || (m.length > 6 ? `${m.slice(0,4)}…${m.slice(-4)}` : m);
                const dex = hops[i % (hops.length || 1)];
                const color = dex === 'Raydium' ? 'text-green-400' : (dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
                const rate = Number.isFinite(rates[i % (rates.length || 1)]) ? rates[i % (rates.length || 1)] : undefined;
                const fee = fees && Number.isFinite(fees[i % fees.length] as any) ? fees[i % fees.length] : undefined;
                const liq = liqs && Number.isFinite(liqs[i % liqs.length] as any) ? liqs[i % liqs.length] : undefined;
                pieces.push(
                  <span key={`${m}-${i}`}>
                    <span className="font-semibold text-white">{symName}</span>{i===0?` (${amt.toFixed(4)})`:''}
                    {i < pathArr.length - 1 && (
                      <span>
                        {' '}
                        <span className={`px-1.5 py-0.5 rounded ${color} bg-gray-800`}>
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
              if (showClosing) {
                const i = edgesCount;
                const last = pathArr[pathArr.length - 1];
                const first = pathArr[0];
                const dex = hops[i % (hops.length || 1)];
                const color = dex === 'Raydium' ? 'text-green-400' : (dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
                const rate = Number.isFinite(rates[i]) ? rates[i] : undefined;
                const fee = fees && Number.isFinite(fees[i] as any) ? fees[i] : undefined;
                const liq = liqs && Number.isFinite(liqs[i] as any) ? liqs[i] : undefined;
                pieces.push(
                  <span key={`${last}-close`}>
                    <span className="font-semibold text-white">{tokenMap[last] || (last.length > 6 ? `${last.slice(0,4)}…${last.slice(-4)}` : last)}</span>
                    <span> <span className={`px-1.5 py-0.5 rounded ${color} bg-gray-800`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{rate ? ` · ×${rate.toFixed(4)} → ${(amt * (rate as number)).toFixed(4)}` : ''}</span> → </span>
                    <span className="font-semibold text-white">{tokenMap[first] || (first.length > 6 ? `${first.slice(0,4)}…${first.slice(-4)}` : first)}</span>
                  </span>
                );
              }
              return pieces;
            })()}
          </div>
          <div className="text-xs text-gray-400 mb-3">
            <span>Profit: {fmtPctFromBps(summary.near_miss.profit_bps)}</span>
            <span className="mx-2">·</span>
            <span>Net: {fmtPctFromBps(summary.near_miss.net_bps || summary.near_miss.profit_bps)}</span>
            <span className="mx-2">·</span>
            <span>Hops: {summary.near_miss.hop_count ?? summary.near_miss.path.length}</span>
            <span className="mx-2">·</span>
            <span>Links: {summary.near_miss.link_edges_used ?? 0}</span>
            <span className="mx-2">·</span>
            <span>Min Edge Liq: {fmt(summary.near_miss.min_edge_liquidity, 2)}</span>
          </div>
          {summary.near_miss.bottleneck && (() => {
            const b = summary.near_miss!.bottleneck!;
            const fromSym = tokenMap[b.from] || (b.from.length > 6 ? `${b.from.slice(0,4)}…${b.from.slice(-4)}` : b.from);
            const toSym = tokenMap[b.to] || (b.to.length > 6 ? `${b.to.slice(0,4)}…${b.to.slice(-4)}` : b.to);
            const color = b.dex === 'Raydium' ? 'text-green-400' : (b.dex === 'Orca' ? 'text-yellow-300' : 'text-blue-300');
            return (
              <div className="text-xs text-gray-400 mb-3">
                Bottleneck: <span className={`px-1.5 py-0.5 rounded ${color} bg-gray-800`}>{b.dex}</span> {fromSym} → {toSym} · rate {fmt(b.rate, 6)} · liq {fmt(b.liquidity, 2)}
              </div>
            );
          })()}
          
          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-xs text-gray-500">Quote:</span>
            <Input 
              className="w-20" 
              type="number" 
              step={0.0001} 
              value={sendAmount} 
              onChange={e=>setSendAmount(parseFloat(e.target.value)||0)} 
            />
            <Select value={sendMode} onChange={e=>setSendMode(e.target.value as any)}>
              <option value="USD">USD</option>
              <option value="TOKENS">Tokens</option>
            </Select>
            {(() => {
              const nm: any = summary?.near_miss as any;
              const hopIds = ((nm?.hop_pool_ids || []) as string[]);
              const hopDexes = ((nm?.hop_dexes || []) as string[]);
              const expectedHops = Math.max(0, ((nm?.hop_count ?? nm?.path?.length) || 0));
              const validHops = expectedHops > 0 && hopIds.length === expectedHops && hopDexes.length === expectedHops;
              const pathClosed = Array.isArray(nm?.path) && nm.path.length ? [...nm.path, nm.path[0]] : nm?.path;
              return (
                <>
                  <Button 
                    size="xs"
                    disabled={sending || !validHops} 
                    title={!validHops ? `Invalid hops` : undefined} 
                    onClick={async ()=>{
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
                    }}
                  >
                    Preflight Simulate
                  </Button>
                  <Button 
                    size="xs"
                    variant="primary"
                    disabled={sending || !validHops} 
                    onClick={async ()=>{
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
                          setNmSimErr(`Execution disabled (mode: ${j.mode}).`);
                        }
                        try { const rh = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const jh = await rh.json(); const allItems = Array.isArray(jh?.items) ? jh.items : []; setTxRows(allItems.slice(0, 10)); } catch {}
                      } catch (e: any) {
                        setNmSimErr(String(e?.message || e));
                      }
                      setSending(false);
                    }}
                  >
                    Execute Direct
                  </Button>
                  <Button 
                    size="xs"
                    disabled={sending || !summary?.near_miss?.path?.length} 
                    onClick={async ()=>{
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
                    }}
                  >
                    Execute via Jupiter
                  </Button>
                  <Button 
                    size="xs"
                    onClick={()=>{
                      try {
                        const ids = (nm)?.hop_pool_ids as string[] | undefined;
                        if (ids && ids.length) {
                          try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { edgeIds: ids } })); } catch {}
                          if (socket) { try { socket.emit('graph-highlight', { edgeIds: ids }); } catch {} }
                          return;
                        }
                        const pathArr: string[] = Array.isArray(nm?.path) ? nm.path : [];
                        const hops: string[] = Array.isArray(nm?.hop_dexes) ? nm.hop_dexes : [];
                        const pairs: Array<{ source: string; target: string; dex?: string }> = [];
                        for (let i = 0; i < pathArr.length - 1; i++) {
                          pairs.push({ source: pathArr[i], target: pathArr[i+1], dex: hops[i % (hops.length || 1)] });
                        }
                        if (pairs.length) {
                          try { window.dispatchEvent(new CustomEvent('graph-highlight', { detail: { pairs } })); } catch {}
                          if (socket) { try { socket.emit('graph-highlight', { pairs }); } catch {} }
                        }
                      } catch {}
                    }}
                  >
                    Highlight in Graph
                  </Button>
                </>
              );
            })()}
          </div>
          
          {/* Simulation Results */}
          {(nmSimErr || (nmSimLogs && nmSimLogs.length)) && (
            <div className="mt-3 p-3 bg-gray-900/50 rounded-lg text-xs">
              {nmSimErr && <div className="text-red-400 mb-2">Error: {nmSimErr}</div>}
              {nmSimLogs && nmSimLogs.length > 0 && (
                <pre className="whitespace-pre-wrap break-words text-gray-400">
                  {nmSimLogs.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Near Misses List */}
      {items.length === 0 && summary?.near_misses && summary.near_misses.length > 0 && (
        <div className="mb-4 p-3 bg-yellow-900/10 border border-yellow-700/30 rounded-lg">
          <div className="text-sm font-semibold text-yellow-400 mb-2">Near-misses this run</div>
          <div className="space-y-2">
            {summary.near_misses.slice(0, 10).map((nm, i) => (
              <div key={i} className="text-xs font-mono text-gray-300">
                <div className="mb-1">{(nm.path || []).map(m => tokenMap[m] || (m.length > 6 ? `${m.slice(0,4)}…${m.slice(-4)}` : m)).join(' → ')}</div>
                <div className="text-gray-500">
                  Profit: {fmtPctFromBps(nm.profit_bps)} · Net: {fmtPctFromBps((nm as any).net_bps || nm.profit_bps)} · Hops: {nm.hop_count ?? nm.path.length}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rejected Opportunities Debug */}
      {rejectedDebug.length > 0 && (
        <div className="mb-4 p-3 bg-red-900/10 border border-red-700/30 rounded-lg">
          <div className="text-sm font-semibold text-red-400 mb-2">Rejected Opportunities (debug)</div>
          <div className="space-y-2">
            {rejectedDebug.map((rej, i) => (
              <div key={`${rej.reason}:${(rej.path || []).join('>')}:${i}`} className="text-xs">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 uppercase tracking-wide text-[10px]">
                    {formatRejectedReason(rej.reason)}
                  </span>
                  {typeof rej.hop_count === 'number' && <span className="text-gray-400">Hops: {rej.hop_count}</span>}
                  {typeof rej.profit_bps === 'number' && <span className="text-gray-400">Profit: {fmtPctFromBps(rej.profit_bps)}</span>}
                  {typeof rej.net_bps === 'number' && rej.net_bps !== rej.profit_bps && <span className="text-gray-400">Net: {fmtPctFromBps(rej.net_bps)}</span>}
                </div>
                <div className="font-mono text-gray-300">{(rej.path || []).map(sym).join(' → ') || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No Opportunities Message */}
      {items.length === 0 && !firstLoad && (!summary?.near_misses || summary.near_misses.length === 0) && (
        <div className="mb-4 text-center py-8 text-gray-500">No opportunities detected</div>
      )}

      {/* Opportunity List */}
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

      {/* Transactions Table */}
      <div className="mt-6 bg-gray-900/50 border border-gray-700/50 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold text-white">Transactions</h4>
          <Button size="xs" onClick={async()=>{ 
            try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); const allItems = Array.isArray(j?.items) ? j.items : []; setTxRows(allItems.slice(0, 10)); } catch {} 
          }}>
            Refresh
          </Button>
        </div>
        <DataTable 
          headers={['Time', 'Path', 'Hops', 'Ix', 'Bytes', 'Status', 'Sig', 'Log']} 
          compact
        >
          {txRows.length > 0 ? txRows.map((r) => {
            const rowKey = `${r.id}:${r.status}:${r.timeMs}`;
            return (
              <React.Fragment key={rowKey}>
                <DataTableRow onClick={() => setExpandedKey(expandedKey === rowKey ? null : rowKey)}>
                  <DataTableCell compact>{new Date(r.timeMs).toLocaleTimeString()}</DataTableCell>
                  <DataTableCell compact mono className="text-xs max-w-[200px] truncate">{(r.path||[]).map(sym).join(' → ')}</DataTableCell>
                  <DataTableCell compact className="text-xs max-w-[200px] truncate">{r.hops.map((h, i) => `${h.dex}`).join(', ')}</DataTableCell>
                  <DataTableCell compact mono>{r.ixCount}</DataTableCell>
                  <DataTableCell compact mono>{r.txSizeBytes}</DataTableCell>
                  <DataTableCell compact className={r.status === 'failed' ? 'text-red-400' : ''}>{r.status}</DataTableCell>
                  <DataTableCell compact>
                    {r.signature ? (
                      <a className="text-blue-400 hover:underline" href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer">
                        {r.signature.slice(0,6)}…
                      </a>
                    ) : '—'}
                  </DataTableCell>
                  <DataTableCell compact>
                    {r.logFile ? (
                      <a className="text-purple-400 hover:text-purple-300" href={`https://files.mccurrach.xyz/files/lockstone-dev/backend/logs/execution-attempts/${r.logFile}`} target="_blank" rel="noreferrer" title={r.logFile}>
                        📋
                      </a>
                    ) : '—'}
                  </DataTableCell>
                </DataTableRow>
                {expandedKey === rowKey && (
                  <tr className="bg-gray-900/80">
                    <td colSpan={8} className="p-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                        <div>
                          <div className="font-semibold text-gray-300 mb-2">Hops</div>
                          <div className="space-y-1">
                            {r.hops.map((h, i) => (
                              <div key={i} className="font-mono text-gray-400">
                                {i+1}. {sym(r.path[i])} → {sym(r.path[i+1])} · {h.dex}/{h.variant} · pool {h.poolId.slice(0,8)}...
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="font-semibold text-gray-300 mb-2">Details</div>
                          <div className="text-gray-400">
                            Ix Count: {r.ixCount} · Size: {r.txSizeBytes} bytes · Status: {r.status}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          }) : (
            <tr><td colSpan={8}><EmptyState message="No transactions" /></td></tr>
          )}
        </DataTable>
      </div>
    </Panel>
  );
};
