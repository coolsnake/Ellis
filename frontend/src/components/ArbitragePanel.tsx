import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocket } from '../app/contexts/socket';
import OpportunityList from './OpportunityList';

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
  detections?: number;
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
};

export const ArbitragePanel: React.FC<{ apiBase: string; socket?: any; showGraph: boolean; onToggleGraph: () => void }> = ({ apiBase, socket, showGraph, onToggleGraph }) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [items, setItems] = useState<Opportunity[]>([]);
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
  const [txRows, setTxRows] = useState<Array<{ id: string; timeMs: number; path: string[]; hops: Array<{ dex: string; variant: string; poolId: string }>; ixCount: number; txSizeBytes: number; status: string; signature?: string | null }>>([]);
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);
  // Show-all toggle moved into OpportunityList
  const lastItemsAtRef = useRef(0);

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
      try { lastItemsAtRef.current = Date.now(); } catch {}
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

  // Initial fallback fetch only
  const [lastDetectionTs, setLastDetectionTs] = useState<number>(0);
  useEffect(() => {
    fetchOpps();
    fetchTokenMap();
    // Load quote size from arb config for display consistency
    (async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.config}`); const j = await r.json(); if (typeof j?.quote_size_usd === 'number') setQuoteSize(Number(j.quote_size_usd)||50); } catch {}
    })();
    (async () => {
      try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); setTxRows(Array.isArray(j?.items) ? j.items : []); } catch {}
    })();
  }, []);

  // Subscribe to backend-bridged opportunities stream
  useEffect(() => {
    if (!effectiveSocket) return;
    const onOpps = (payload: { items?: Opportunity[]; summary?: OpportunitiesSummary }) => {
      try {
        if (Array.isArray(payload?.items)) setItems(payload.items as Opportunity[]);
        if (payload && typeof payload === 'object' && 'summary' in payload) setSummary((payload as any).summary || null);
        try { lastItemsAtRef.current = Date.now(); } catch {}
      } catch {}
    };
    try { effectiveSocket.on('arb:opportunities', onOpps); } catch {}
    return () => { try { effectiveSocket.off('arb:opportunities', onOpps); } catch {} };
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
      try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); setTxRows(Array.isArray(j?.items) ? j.items : []); } catch {}
    };
    // Fallback: when opportunity-related logs arrive and no fresh items were received recently, fetch snapshot
    const onArbLog = (evt: any) => {
      try {
        const msg: string = (evt?.message || '').toString();
        const code: string = String(evt?.code || '').toUpperCase();
        const cat: string = String(evt?.cat || evt?.context?.cat || '').toLowerCase();
        const isPretradeArb = /\bpretrade:arb\b/.test(msg) || /^PRETRADE\./.test(code);
        const isOpportunityCat = cat === 'opportunity';
        const isOpportunityMsg = /^opportunity:/.test(msg) || /arb\.(opportunity|near_miss)/i.test(msg) || /^ARB\.(OPPORTUNITY|NEAR_MISS)/.test(code);
        const now = Date.now();
        if ((isPretradeArb || isOpportunityCat || isOpportunityMsg) && (now - (lastItemsAtRef.current || 0) > 1500)) {
          fetchOpps();
        }
      } catch {}
    };
    effectiveSocket.on('tx:start', onTxAny);
    effectiveSocket.on('tx:resolved', onTxAny);
    effectiveSocket.on('tx:sim.ok', onTxAny);
    effectiveSocket.on('tx:sim.err', onTxAny);
    effectiveSocket.on('tx:send.ok', onTxAny);
    effectiveSocket.on('tx:send.err', onTxAny);
    try { effectiveSocket.on('log', onArbLog); } catch {}
    return () => {
      effectiveSocket.off('tx:start', onTxAny);
      effectiveSocket.off('tx:resolved', onTxAny);
      effectiveSocket.off('tx:sim.ok', onTxAny);
      effectiveSocket.off('tx:sim.err', onTxAny);
      effectiveSocket.off('tx:send.ok', onTxAny);
      effectiveSocket.off('tx:send.err', onTxAny);
      try { effectiveSocket.off('log', onArbLog); } catch {}
    };
  }, [effectiveSocket]);

  // Remove periodic polling; rely on socket-driven refreshes

  return (
    <div className="p-2 border rounded bg-white/5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">Arbitrage Opportunities</h3>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 border rounded" onClick={()=>{ try { (window as any).dispatchEvent(new CustomEvent('open-graph-config')); } catch {} }}>Graph Config</button>
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
            <div className="text-gray-400">Active</div>
            <div className="text-sm">{fmt(summary?.count)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Top Profit</div>
            <div className="text-sm">{fmtPctFromBps(summary?.max_profit_bps)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Avg Profit</div>
            <div className="text-sm">{fmtPctFromBps(Number.isFinite(summary?.avg_profit_bps as any) ? Math.round((summary?.avg_profit_bps || 0)) : 0)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Avg Net</div>
            <div className="text-sm">{fmtPctFromBps(Number.isFinite(summary?.avg_net_bps as any) ? Math.round((summary?.avg_net_bps || 0)) : 0)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Avg Hops</div>
            <div className="text-sm">{fmt(summary?.avg_hop_count, 2)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Avg Link Edges</div>
            <div className="text-sm">{fmt(summary?.avg_link_edges_used, 2)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Min Edge Liq (avg)</div>
            <div className="text-sm">{fmt(summary?.min_edge_liquidity_avg, 2)}</div>
          </div>
          <div className="p-2 rounded bg-black/20">
            <div className="text-gray-400">Min Edge Liq (min)</div>
            <div className="text-sm">{fmt(summary?.min_edge_liquidity_min, 2)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] mt-2 opacity-80">
          <div>Last Detection: {age(summary?.last_detection_ms)}</div>
          <div>Detect Ms: {fmt(summary?.detection_duration_ms)}</div>
          <div>Ingest Ms: {fmt(summary?.ingestion_duration_ms)}</div>
          <div>Graph: {fmt(summary?.graph_nodes)} nodes / {fmt(summary?.graph_edges)} edges</div>
          <div>Pools: {fmt(summary?.pools_amm)} AMM / {fmt(summary?.pools_clmm)} CLMM</div>
          <div>Orca Refresh: {age(summary?.last_orca_ms)}</div>
          <div>Raydium Refresh: {age(summary?.last_raydium_ms)}</div>
        </div>
      </div>
      {items.length === 0 && summary?.near_miss && !firstLoad && (
        <div className="p-2 border rounded bg-yellow-900/20 text-xs mb-3">
          <div className="font-semibold mb-1">Closest Path (below threshold by {fmt(summary?.near_miss_shortfall_bps)} bps)</div>
          <div className="font-mono mb-1">
            {(() => {
              const hops = summary.near_miss?.hop_dexes || [];
              const rates = summary.near_miss?.hop_rates || [];
              const outs = (summary.near_miss as any)?.hop_outs as number[] | undefined;
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
                const out = outs && Number.isFinite(outs[i % outs.length] as any) ? outs[i % outs.length] : undefined;
                pieces.push(
                  <span key={`${m}-${i}`}>
                    <span className="font-semibold">{sym}</span>{i===0?` (${amt.toFixed(4)})`:''}
                    {i < pathArr.length - 1 && (
                      <span>
                        {' '}
                        <span className={`px-1 rounded ${color}`}>
                          {dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{out!=null ? ` · → ${Number(out).toFixed(4)}` : (rate ? ` · ×${rate.toFixed(4)} → ${(amt * rate).toFixed(4)}` : '')}
                        </span>
                        {' '}→{' '}
                      </span>
                    )}
                  </span>
                );
                if (i < pathArr.length - 1) {
                  if (out != null) amt = Number(out); else if (rate) amt = amt * rate;
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
                const out = outs && Number.isFinite(outs[i] as any) ? outs[i] : undefined;
                pieces.push(
                  <span key={`${last}-close`}>
                    <span className="font-semibold">{tokenMap[last] || (last.length > 6 ? `${last.slice(0,4)}…${last.slice(-4)}` : last)}</span>
                    <span> <span className={`px-1 rounded ${color}`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{out!=null ? ` · → ${Number(out).toFixed(4)}` : (rate ? ` · ×${rate.toFixed(4)} → ${(amt * (rate as number)).toFixed(4)}` : '')}</span> → </span>
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
            <button className={`px-2 py-1 border rounded ${sending?'opacity-60':''}`} disabled={sending} onClick={async ()=>{
              if (!summary?.near_miss?.path?.length) return;
              setSending(true);
              try {
                const nm: any = summary.near_miss as any;
                const body: any = { path: nm.path, hopPoolIds: nm.hop_pool_ids || [], dexes: nm.hop_dexes || [] };
                if (sendMode === 'USD') body.sizeUsd = Number(sendAmount)||0; else body.size = Number(sendAmount)||0;
                const r = await fetch(`${apiBase}${ROUTES.arb.simulate}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                await r.json().catch(()=>({}));
              } catch {}
              setSending(false);
            }}>Simulate Direct</button>
            <button className={`px-2 py-1 border rounded ${sending?'opacity-60':''}`} disabled={sending} onClick={async ()=>{
              if (!summary?.near_miss?.path?.length) return;
              setSending(true);
              try {
                const nm: any = summary.near_miss as any;
                const body: any = { path: nm.path, hopPoolIds: nm.hop_pool_ids || [], dexes: nm.hop_dexes || [] };
                if (sendMode === 'USD') body.sizeUsd = Number(sendAmount)||0; else body.size = Number(sendAmount)||0;
                const r = await fetch(`${apiBase}${ROUTES.arb.execute}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                await r.json().catch(()=>({}));
              } catch {}
              setSending(false);
            }}>Execute Direct</button>
          </div>
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
      />
      <div className="mt-4 p-2 border rounded bg-black/10">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold">Transactions</h4>
          <button className="px-2 py-1 border rounded" onClick={async()=>{ try { const r = await fetch(`${apiBase}${ROUTES.arb.txHistory}?limit=50`); const j = await r.json(); setTxRows(Array.isArray(j?.items) ? j.items : []); } catch {} }}>Refresh</button>
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
              </tr>
            </thead>
            <tbody>
              {txRows.map((r) => (
                <>
                  <tr key={r.id} className="border-t border-white/10 cursor-pointer" onClick={()=> setExpandedTxId(expandedTxId===r.id?null:r.id)}>
                    <td className="py-1 pr-2">{new Date(r.timeMs).toLocaleTimeString()}</td>
                    <td className="py-1 pr-2 font-mono">{(r.path||[]).map(m=>tokenMap[m]||m.slice(0,4)+'…'+m.slice(-4)).join(' → ')}</td>
                    <td className="py-1 pr-2">{r.hops.map(h=>`${h.dex}/${h.variant}`).join(', ')}</td>
                    <td className="py-1 pr-2">{r.ixCount}</td>
                    <td className="py-1 pr-2">{r.txSizeBytes}</td>
                    <td className="py-1 pr-2">{r.status}</td>
                    <td className="py-1 pr-2">{r.signature ? <a className="text-blue-400 underline" href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer">{r.signature.slice(0,6)}…</a> : '—'}</td>
                  </tr>
                  {expandedTxId === r.id && (
                    <tr key={`${r.id}-exp`} className="bg-black/20">
                      <td colSpan={7} className="py-2 px-2">
                        <div className="text-[11px] grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <div className="font-semibold mb-1">Hops</div>
                            <div className="space-y-1">
                              {r.hops.map((h, i) => (
                                <div key={i} className="font-mono">{i+1}. {h.dex}/{h.variant} · pool {h.poolId}</div>
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
              ))}
              {txRows.length === 0 && (
                <tr><td className="py-2 opacity-70" colSpan={7}>No transactions</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};


