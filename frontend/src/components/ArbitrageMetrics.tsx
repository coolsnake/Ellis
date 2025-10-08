import React from 'react';
import { ROUTES } from '../utils/routes';
import { useSocket } from '../app/contexts/socket';

export const ArbitrageMetrics: React.FC<{ apiBase: string; paused?: boolean; socket?: any }> = (
  { apiBase, paused, socket }: { apiBase: string; paused?: boolean; socket?: any }
) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [m, setM] = React.useState<any | null>(null);
  const [pools, setPools] = React.useState<any | null>(null);
  const [orcaPools, setOrcaPools] = React.useState<any | null>(null);
  const [saberPools, setSaberPools] = React.useState<any | null>(null);
  const [mblPools, setMblPools] = React.useState<any | null>(null);
  const [poolsStats, setPoolsStats] = React.useState<any | null>(null);
  const [subscribed, setSubscribed] = React.useState<boolean>(false);
  const [wsHealthy, setWsHealthy] = React.useState<boolean>(false);
  const [lastEventMs, setLastEventMs] = React.useState<number>(0);
  const [arbEnabled, setArbEnabled] = React.useState<boolean>(false);
  const [wsDetails, setWsDetails] = React.useState<{ orca?: { attached?: number; events?: number }, raydium?: { attached?: number; events?: number }, meteora?: { attached?: number; events?: number } }>({});
  const [poolAges, setPoolAges] = React.useState<any | null>(null);

  const fetchMetrics = async () => {
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const r = await fetch(`${apiBase}${ROUTES.arb.metricsJson}`, { headers });
      if (r.ok) {
        const j = await r.json();
        setM(j);
        if (j?.pools) setPoolsStats(j.pools);
        if (j?.pools_age_ms) setPoolAges(j.pools_age_ms);
      }
    } catch {}
  };

  const refreshPoolsAndMetrics = async () => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      // Unified refresh also subscribes server-side by default
      await fetch(`${apiBase}${ROUTES.pools.refresh}`, { method: 'POST', headers, body: JSON.stringify({ source: 'all', subscribe: true }) });
    } catch {}
    // Re-pull scoped pools and metrics
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      fetch(`${apiBase}${ROUTES.pools.raydium}`, { headers }).then(r=>r.json()).then(setPools).catch(()=>{});
    } catch {}
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      fetch(`${apiBase}${ROUTES.pools.orca}`, { headers }).then(r=>r.json()).then(setOrcaPools).catch(()=>{});
    } catch {}
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      fetch(`${apiBase}${ROUTES.pools.saber}`, { headers }).then(r=>r.json()).then(setSaberPools).catch(()=>{});
    } catch {}
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      fetch(`${apiBase}${ROUTES.pools.meteoraBalanced}`, { headers }).then(r=>r.json()).then(setMblPools).catch(()=>{});
    } catch {}
    fetchMetrics();
    try { window.dispatchEvent(new CustomEvent('graph-refresh')); } catch {}
  };

  React.useEffect(() => {
    if (paused) return;
    fetchMetrics();
    fetch(`${apiBase}${ROUTES.arb.metricsJson}`).catch(()=>{});
    // Probe arb config to detect enabled state
    fetch(`${apiBase}${ROUTES.arb.config}`).then(r=>r.json()).then((j)=>{ if (j && typeof j.enabled === 'boolean') setArbEnabled(!!j.enabled); }).catch(()=>{});
    fetch(`${apiBase}${ROUTES.pools.subscriptions}`).then(r=>r.json()).then((j)=>{ setSubscribed(!!j.wsEnabled); setWsHealthy(!!j.wsHealthy); setLastEventMs(Number(j.lastEventMs||0)); setWsDetails(j.ws || {}); }).catch(()=>{});
    return () => {};
  }, [paused]);

  // Subscribe to socket events to refresh metrics on push updates
  React.useEffect(() => {
    if (!effectiveSocket || paused) return;
    const onGraphSnapshot = () => { try { fetchMetrics(); } catch {} };
    const onGraphUpdate = () => { try { fetchMetrics(); } catch {} };
    const onWsActivity = (evt: any) => {
      try {
        if (!evt) return;
        setWsHealthy(!!evt.healthy);
        setLastEventMs(Number(evt.lastEventMs || 0));
        setWsDetails({ orca: evt.orca, raydium: evt.raydium, meteora: evt.meteora });
      } catch {}
    };
    const onArbLog = (evt: any) => {
      try {
        const msg: string = (evt?.message || '').toString();
        const code: string = String(evt?.code || '').toUpperCase();
        const cat: string = String(evt?.cat || evt?.context?.cat || '').toLowerCase();
        const isPretradeArb = /\bpretrade:arb\b/i.test(msg) || /^PRETRADE\./.test(code);
        const isOpportunityCat = cat === 'opportunity';
        const isGraphPush = /^GRAPH\.PUSH\.(SNAPSHOT|DIFF)$/.test(code) || /^(graph:push (snapshot|diff))$/i.test(msg);
        const isArbPush = /^ARB\.PUSH\.SNAPSHOT$/.test(code) || /^arb:push snapshot$/i.test(msg);
        if (isPretradeArb || isOpportunityCat || isGraphPush || isArbPush) {
          fetchMetrics();
        }
      } catch {}
    };
    try { effectiveSocket.on('graph-snapshot', onGraphSnapshot); } catch {}
    try { effectiveSocket.on('graph-update', onGraphUpdate); } catch {}
    try { effectiveSocket.on('ws-activity', onWsActivity); } catch {}
    try { effectiveSocket.on('log', onArbLog); } catch {}
    return () => {
      try { effectiveSocket.off('graph-snapshot', onGraphSnapshot); } catch {}
      try { effectiveSocket.off('graph-update', onGraphUpdate); } catch {}
      try { effectiveSocket.off('ws-activity', onWsActivity); } catch {}
      try { effectiveSocket.off('log', onArbLog); } catch {}
    };
  }, [effectiveSocket, paused]);

  const fmt = (v: any) => typeof v === 'number' ? v.toLocaleString() : String(v || '-');
  const ago = (ms?: number) => {
    if (!ms) return '-';
    const s = Math.max(0, Math.floor((Date.now() - ms)/1000));
    return `${s}s ago`;
  };

  return (
    <div className="p-3 border rounded bg-gray-900">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">Arbitrage Metrics</h3>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 border rounded bg-green-700/70" onClick={async()=>{
            try {
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              try {
                const s = localStorage.getItem('authCreds');
                if (s) {
                  const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
                  if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
                }
              } catch {}
              await fetch(`${apiBase}/arb/start`, { method: 'POST', headers, body: JSON.stringify({ enable: !arbEnabled }) }).catch(()=>{});
              setArbEnabled(v => !v);
            } catch {}
          }}>{arbEnabled ? 'Stop Arb' : 'Start Arb'}</button>
          <button className="px-2 py-1 border rounded" onClick={refreshPoolsAndMetrics}>Refresh Pools</button>
          <button className="px-2 py-1 border rounded" onClick={async ()=>{
            try {
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              try {
                const s = localStorage.getItem('authCreds');
                if (s) {
                  const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
                  if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
                }
              } catch {}
              await fetch(`${apiBase}${ROUTES.pools.retarget}`, { method: 'POST', headers }).catch(()=>{});
              fetchMetrics();
            } catch {}
          }}>Retarget WS</button>
          <span className={`px-2 py-0.5 text-xs rounded border ${wsHealthy ? 'bg-green-700/50 border-green-600' : 'bg-yellow-700/50 border-yellow-600'}`}>
            {wsHealthy ? `WS Active: Ray ${wsDetails.raydium?.attached||0}/${(wsDetails as any)?.raydium?.target||0} ev=${wsDetails.raydium?.events||0}, Orca ${wsDetails.orca?.attached||0}/${(wsDetails as any)?.orca?.target||0} ev=${wsDetails.orca?.events||0}, Met ${wsDetails.meteora?.attached||0}/${(wsDetails as any)?.meteora?.target||0} ev=${wsDetails.meteora?.events||0} · idle ${ago(lastEventMs)}` : `WS Idle · idle ${ago(lastEventMs)}`}
          </span>
        </div>
      </div>
      {!m ? <div className="text-sm opacity-70">Loading...</div> : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
          <div><div className="text-gray-400">Active Opps</div><div>{fmt(m.opportunities_active)}</div></div>
          <div><div className="text-gray-400">Max Profit (bps)</div><div>{fmt(m.max_profit_bps)}</div></div>
          <div><div className="text-gray-400">Avg Profit (bps)</div><div>{typeof m.avg_profit_bps === 'number' ? m.avg_profit_bps.toFixed(2) : '-'}</div></div>
          <div><div className="text-gray-400">Graph Nodes</div><div>{fmt((typeof m.backend_graph_nodes === 'number' && m.backend_graph_nodes > 0) ? m.backend_graph_nodes : m.graph_nodes)}</div></div>
          <div><div className="text-gray-400">Graph Edges</div><div>{fmt((typeof m.backend_graph_edges === 'number' && m.backend_graph_edges > 0) ? m.backend_graph_edges : m.graph_edges)}</div></div>
          <div><div className="text-gray-400">Last Detection</div><div>{ago(m.last_detection_ms)}</div></div>
          <div><div className="text-gray-400">Ingestion (ms)</div><div>{fmt(m.ingestion_duration_ms)}</div></div>
          <div><div className="text-gray-400">Detection (ms)</div><div>{fmt(m.detection_duration_ms)}</div></div>
          {typeof m?.diff_to_detect_ms === 'number' ? (<div><div className="text-gray-400">Arb diff→detect (ms)</div><div>{fmt(m.diff_to_detect_ms)}</div></div>) : null}
          {typeof m?.arb_graph_version_delta === 'number' || typeof m?.arb_graph_age_ms === 'number' ? (
            <div><div className="text-gray-400">Backend↔arb-rs Graph</div><div>Δv={fmt(m.arb_graph_version_delta)} age={fmt(m.arb_graph_age_ms)}ms</div></div>
          ) : null}
          <div className="col-span-2"><div className="text-gray-400">Requests (Jup/Ray/Orca)</div><div>{fmt(m.ingestion_requests_total_jupiter)} / {fmt(m.ingestion_requests_total_raydium)} / {fmt(m.ingestion_requests_total_orca)}</div></div>
          <div className="col-span-2"><div className="text-gray-400">Errors (Jup/Ray/Orca)</div><div>{fmt(m.ingestion_errors_total_jupiter)} / {fmt(m.ingestion_errors_total_raydium)} / {fmt(m.ingestion_errors_total_orca)}</div></div>
          <div><div className="text-gray-400">WS Pushes</div><div>{fmt(m.ws_push_total)}</div></div>
          <div><div className="text-gray-400">WS Skipped</div><div>{fmt(m.ws_skipped_nochange_total)}</div></div>
          <div className="col-span-2 border-t border-gray-700 pt-2">
            <div className="text-gray-400">Raydium Pools (scoped)</div>
            {!pools ? <div className="opacity-70">-</div> : (
              <div>AMM: {fmt(pools.amm?.length)} CLMM: {fmt(pools.clmm?.length)}</div>
            )}
          </div>
            <div className="col-span-2">
            <div className="text-gray-400">Orca Pools (scoped)</div>
            {!orcaPools ? <div className="opacity-70">-</div> : (
              <div>AMM: {fmt(orcaPools.amm?.length)} CLMM: {fmt(orcaPools.clmm?.length)}</div>
            )}
          </div>
            <div className="col-span-2">
              <div className="text-gray-400">Saber Pools (scoped)</div>
              {!saberPools ? <div className="opacity-70">-</div> : (
                <div>AMM: {fmt(saberPools.amm?.length)}</div>
              )}
            </div>
            <div className="col-span-2">
              <div className="text-gray-400">Meteora Balanced Pools (scoped)</div>
              {!mblPools ? <div className="opacity-70">-</div> : (
                <div>AMM: {fmt(mblPools.amm?.length)}</div>
              )}
            </div>
          {poolAges ? (
            <div className="col-span-2">
              <div className="text-gray-400">Pool Cache Age</div>
              <div className="flex gap-2 text-xs">
                <span className={`px-1 rounded border ${Number(poolAges.raydium) > Number(poolAges.ttl?.raydium) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>Ray {fmt(poolAges.raydium)}ms / TTL {fmt(poolAges.ttl?.raydium)}ms</span>
                <span className={`px-1 rounded border ${Number(poolAges.orca) > Number(poolAges.ttl?.orca) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>Orc {fmt(poolAges.orca)}ms / TTL {fmt(poolAges.ttl?.orca)}ms</span>
                <span className={`px-1 rounded border ${Number(poolAges.meteora) > Number(poolAges.ttl?.meteora) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>Met {fmt(poolAges.meteora)}ms / TTL {fmt(poolAges.ttl?.meteora)}ms</span>
                <span className={`px-1 rounded border ${Number(poolAges.saber) > Number(poolAges.ttl?.saber) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>Sab {fmt(poolAges.saber)}ms / TTL {fmt(poolAges.ttl?.saber)}ms</span>
                <span className={`px-1 rounded border ${Number(poolAges.meteora_balanced) > Number(poolAges.ttl?.meteora_balanced) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>MetBal {fmt(poolAges.meteora_balanced)}ms / TTL {fmt(poolAges.ttl?.meteora_balanced)}ms</span>
              </div>
            </div>
          ) : null}
          {poolsStats ? (
            <div className="col-span-2 border-t border-gray-700 pt-2">
              <div className="text-gray-400">Pool Fetch Stats</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div>
                  <div className="text-gray-400">Raydium Fetches / Last Ms</div>
                  <div>{fmt(poolsStats.raydium?.fetches)} / {fmt(poolsStats.raydium?.lastMs)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Raydium Last (AMM/CLMM) &rarr; Filtered</div>
                  <div>{fmt(poolsStats.raydium?.lastAmm)} / {fmt(poolsStats.raydium?.lastClmm)} {'\u2192'} {fmt(poolsStats.raydium?.filteredAmm)} / {fmt(poolsStats.raydium?.filteredClmm)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Raydium Universe / Zero-Overlap Skips</div>
                  <div>{String(poolsStats.raydium?.universe || '-')} / {fmt(poolsStats.raydium?.zeroOverlapSkips)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Orca Fetches / Last Ms</div>
                  <div>{fmt(poolsStats.orca?.fetches)} / {fmt(poolsStats.orca?.lastMs)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Orca Last (AMM/CLMM)</div>
                  <div>{fmt(poolsStats.orca?.lastAmm)} / {fmt(poolsStats.orca?.lastClmm)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Meteora Fetches / Last Ms</div>
                  <div>{fmt(poolsStats.meteora?.fetches)} / {fmt(poolsStats.meteora?.lastMs)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Meteora Last (CLMM)</div>
                  <div>{fmt(poolsStats.meteora?.lastClmm)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Saber Fetches / Last Ms</div>
                  <div>{fmt(poolsStats.saber?.fetches)} / {fmt(poolsStats.saber?.lastMs)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Saber Last (AMM)</div>
                  <div>{fmt(poolsStats.saber?.lastAmm)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Meteora Balanced Fetches / Last Ms</div>
                  <div>{fmt(poolsStats.meteora_balanced?.fetches)} / {fmt(poolsStats.meteora_balanced?.lastMs)}</div>
                </div>
                <div>
                  <div className="text-gray-400">Meteora Balanced Last (AMM)</div>
                  <div>{fmt(poolsStats.meteora_balanced?.lastAmm)}</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};


