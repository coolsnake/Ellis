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
  detections?: number;
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
  }: {
    items: Opportunity[];
    tokenMap: Record<string, string>;
    quoteSize: number;
    quoteSizeMint: string;
    sendMode: 'USD' | 'TOKENS';
    sendAmount: number;
    apiBase: string;
    socket?: any;
  }
): React.ReactElement {
  const [showAll, setShowAll] = React.useState(false);
  const [simLogs, setSimLogs] = React.useState<string[] | null>(null);
  const [simErr, setSimErr] = React.useState<string | null>(null);

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

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs opacity-70">{showAll ? `Showing ${items.length}` : `Showing ${Math.min(10, items.length)} of ${items.length}`}</span>
        <button className="px-2 py-1 border rounded" onClick={()=> setShowAll(!showAll)}>{showAll ? 'Show Top 10' : 'Show All'}</button>
      </div>
      <div className="max-h-96 overflow-y-auto">
        <div className="space-y-2">
        {visible.map((op) => {
          const key = `${(op.path||[]).join('>')}|${(op.dexes||[]).join('>')}`;
          return (
          <div key={key} className="p-2 border rounded bg-black/20">
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
                  } else if (j && j.mode && j.mode !== 'direct') {
                    setSimErr(`Execution disabled (mode: ${j.mode}). Enable 'direct' in Exec Config.`);
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
                  body.hopRates = Array.isArray((op as any)?.hop_rates) ? (op as any).hop_rates : [];
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
            <div className="text-[11px] opacity-60">First {ago(op.first_seen_ms)} · Last {ago(op.detected_ms)} · Hits {op.detections ?? 1}</div>
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


