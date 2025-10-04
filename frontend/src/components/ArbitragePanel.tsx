import React, { useEffect, useMemo, useState } from 'react';

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
};

export const ArbitragePanel: React.FC<{ apiBase: string; socket?: any }> = ({ apiBase, socket }) => {
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
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiBase}/arb/opportunities`);
      const j = await r.json();
      setItems((j?.items as Opportunity[]) || []);
      setSummary((j?.summary as OpportunitiesSummary) || null);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const fetchTokenMap = async () => {
    try {
      const r = await fetch(`${apiBase}/tokens/map`);
      const j = await r.json();
      setTokenMap((j?.map as Record<string, string>) || {});
    } catch {}
  };

  // Refresh only when arb detection cycles or graph changes
  const [lastGraphVersion, setLastGraphVersion] = useState<number>(0);
  const [lastDetectionTs, setLastDetectionTs] = useState<number>(0);
  useEffect(() => {
    fetchOpps();
    fetchTokenMap();
    // Load quote size from arb config for display consistency
    (async () => {
      try { const r = await fetch(`${apiBase}/arb/config`); const j = await r.json(); if (typeof j?.quote_size_usd === 'number') setQuoteSize(Number(j.quote_size_usd)||50); } catch {}
    })();
  }, []);
  useEffect(() => {
    if (!socket) return;
    const onGraphSnapshot = (snap: { version: number }) => {
      if (typeof snap?.version === 'number' && snap.version !== lastGraphVersion) {
        setLastGraphVersion(snap.version);
        fetchOpps();
      }
    };
    const onGraphUpdate = (diff: { version: number }) => {
      if (typeof diff?.version === 'number' && diff.version !== lastGraphVersion) {
        setLastGraphVersion(diff.version);
        fetchOpps();
      }
    };
    const onArbLog = (evt: any) => {
      const msg: string = (evt?.message || '').toString();
      const cat: string = String(evt?.cat || evt?.context?.cat || '').toLowerCase();
      const isPretradeArb = /\bpretrade:arb\b/.test(msg);
      const isOpportunityCat = cat === 'opportunity';
      const isOpportunityMsg = /^opportunity:/.test(msg) || /arb\.(opportunity|near_miss)/i.test(msg);
      if (isPretradeArb || isOpportunityCat || isOpportunityMsg) {
        setLastDetectionTs(Date.now());
        fetchOpps();
      }
    };
    socket.on('graph-snapshot', onGraphSnapshot);
    socket.on('graph-update', onGraphUpdate);
    socket.on('log', onArbLog);
    return () => {
      socket.off('graph-snapshot', onGraphSnapshot);
      socket.off('graph-update', onGraphUpdate);
      socket.off('log', onArbLog);
    };
  }, [socket, lastGraphVersion]);

  return (
    <div className="p-2 border rounded bg-white/5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">Arbitrage Opportunities</h3>
      </div>
      {error && <div className="text-red-400 text-sm mb-2">{error}</div>}
      {loading && <div className="text-sm">Loading...</div>}
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
      {!loading && items.length === 0 && summary?.near_miss && (
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
                const body: any = { path: summary.near_miss.path, hop_pool_ids: (summary.near_miss as any)?.hop_pool_ids };
                if (sendMode === 'USD') body.sizeUsd = Number(sendAmount)||0; else body.size = Number(sendAmount)||0;
                const r = await fetch(`${apiBase}/arb/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                await r.json().catch(()=>({}));
              } catch {}
              setSending(false);
            }}>Send</button>
          </div>
        </div>
      )}
      {!loading && items.length === 0 && <div className="text-sm opacity-70">No opportunities</div>}
      {summary?.near_miss && typeof summary?.near_miss_shortfall_bps === 'number' && (summary.near_miss_shortfall_bps as number) > 0 && (summary.near_miss.hop_count ?? summary.near_miss.path.length) >= 3 && (
        <div className="p-2 border rounded bg-yellow-900/20 text-xs mb-3">
          <div className="font-semibold mb-1">Closest Path{summary?.near_miss_shortfall_bps !== undefined ? ` (below threshold by ${fmt(summary?.near_miss_shortfall_bps)} bps)` : ''}</div>
          <div className="font-mono mb-1">{summary.near_miss.path.join(' → ')}</div>
          <div>Profit: {fmtPctFromBps(summary.near_miss.profit_bps)} · Net: {fmtPctFromBps(summary.near_miss.net_bps || summary.near_miss.profit_bps)}</div>
          <div>Hops: {summary.near_miss.hop_count ?? summary.near_miss.path.length} · Links: {summary.near_miss.link_edges_used ?? 0} · Min Edge Liq: {fmt(summary.near_miss.min_edge_liquidity, 2)}</div>
          {summary.near_miss.bottleneck && (
            <div>Bottleneck: {summary.near_miss.bottleneck.dex} {summary.near_miss.bottleneck.from} → {summary.near_miss.bottleneck.to} · rate {fmt(summary.near_miss.bottleneck.rate, 6)} · liq {fmt(summary.near_miss.bottleneck.liquidity, 2)}</div>
          )}
        </div>
      )}
      <div className="space-y-2">
        {items.map((op, idx) => (
          <div key={idx} className="p-2 border rounded bg-black/20">
            <div className="text-sm">
              <span className="font-mono">
                {(() => {
                  const hops = op.hop_dexes || [];
                  const rates = (op as any).hop_rates || [];
                  const outs = (op as any).hop_outs as number[] | undefined;
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
                    const out = outs && Number.isFinite(outs[i % (outs.length || 1)] as any) ? outs[i % (outs.length || 1)] : undefined;
                    pieces.push(
                      <span key={`${m}-${i}`}>
                        <span className="font-semibold">{sym}</span>{i===0?` (${amt.toFixed(4)})`:''}
                        {i < pathArr.length - 1 && (
                          <span> <span className={`px-1 rounded ${color}`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{out!=null ? ` · → ${Number(out).toFixed(4)}` : (rate ? ` · ×${rate.toFixed(4)} → ${(amt * rate).toFixed(4)}` : '')}</span> → </span>
                        )}
                      </span>
                    );
                    if (i < pathArr.length - 1) {
                      if (out != null) amt = Number(out); else if (rate) amt = amt * rate;
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
                    const out = outs && Number.isFinite((outs as any)[i] as any) ? (outs as any)[i] : undefined;
                    pieces.push(
                      <span key={`${last}-close`}>
                        <span className="font-semibold">{tokenMap[last] || (last.length > 6 ? `${last.slice(0,4)}…${last.slice(-4)}` : last)}</span>
                        <span> <span className={`px-1 rounded ${color}`}>{dex || '—'}{fee!=null ? ` · fee ${fee}bps` : ''}{liq!=null ? ` · liq ${fmt(liq, 2)}` : ''}{out!=null ? ` · → ${Number(out).toFixed(4)}` : (rate ? ` · ×${(rate as number).toFixed(4)} → ${(amt * (rate as number)).toFixed(4)}` : '')}</span> → </span>
                        <span className="font-semibold">{tokenMap[first] || (first.length > 6 ? `${first.slice(0,4)}…${first.slice(-4)}` : first)}</span>
                      </span>
                    );
                  }
                  return pieces;
                })()}
              </span>
            </div>
            <div className="text-xs opacity-80">DEXes: {op.dexes.join(', ')}</div>
            <div className="text-xs">Profit: {fmtPctFromBps(op.profit_bps)} · Net: {fmtPctFromBps(op.net_bps)} · ${fmt(op.est_profit_usd, 2)}</div>
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
            </div>
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
            <div className="text-[11px] opacity-60">Seen: {age(op.first_seen_ms || op.detected_ms)} · Detections: {op.detections ?? 1}</div>
          </div>
        ))}
      </div>
    </div>
  );
};


