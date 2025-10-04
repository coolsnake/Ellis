import React from 'react';

export const ArbitrageMetrics: React.FC<{ apiBase: string; paused?: boolean }> = ({ apiBase, paused }) => {
  const [m, setM] = React.useState<any | null>(null);
  const [pools, setPools] = React.useState<any | null>(null);
  const [orcaPools, setOrcaPools] = React.useState<any | null>(null);
  const [poolsStats, setPoolsStats] = React.useState<any | null>(null);
  const [subscribed, setSubscribed] = React.useState<boolean>(false);
  const [wsHealthy, setWsHealthy] = React.useState<boolean>(false);

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
      const r = await fetch(`${apiBase}/arb/metrics/json`, { headers });
      if (r.ok) {
        const j = await r.json();
        setM(j);
        if (j?.pools) setPoolsStats(j.pools);
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
      await fetch(`${apiBase}/arb/pools/refresh`, { method: 'POST', headers, body: JSON.stringify({ source: 'all' }) });
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
      fetch(`${apiBase}/arb/pools/raydium`, { headers }).then(r=>r.json()).then(setPools).catch(()=>{});
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
      fetch(`${apiBase}/arb/pools/orca`, { headers }).then(r=>r.json()).then(setOrcaPools).catch(()=>{});
    } catch {}
    fetchMetrics();
    try { window.dispatchEvent(new CustomEvent('graph-refresh')); } catch {}
  };

  React.useEffect(() => {
    if (paused) return;
    fetchMetrics();
    fetch(`${apiBase}/arb/metrics/json`).catch(()=>{});
    fetch(`${apiBase}/arb/pools/raydium`).then(r=>r.json()).then(setPools).catch(()=>{});
    fetch(`${apiBase}/arb/pools/orca`).then(r=>r.json()).then(setOrcaPools).catch(()=>{});
    fetch(`${apiBase}/arb/pools/subscriptions`).then(r=>r.json()).then((j)=>{ setSubscribed(!!j.enablePoolWs); setWsHealthy(!!j.healthy); }).catch(()=>{});
    const id = setInterval(fetchMetrics, 2000);
    return () => clearInterval(id);
  }, [paused]);

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
          <button className="px-2 py-1 border rounded" onClick={fetchMetrics}>Refresh Metrics</button>
          <button className="px-2 py-1 border rounded" onClick={refreshPoolsAndMetrics}>Refresh Pools</button>
          <button className="px-2 py-1 border rounded" onClick={async()=>{
            try {
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              try {
                const s = localStorage.getItem('authCreds');
                if (s) {
                  const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
                  if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
                }
              } catch {}
              await fetch(`${apiBase}/arb/pools/subscribe`, { method: 'POST', headers }).catch(()=>{});
              setSubscribed(true);
            } catch {}
          }}>Subscribe</button>
          {subscribed ? (
            <span className={`px-2 py-0.5 text-xs rounded border ${wsHealthy ? 'bg-green-700/50 border-green-600' : 'bg-yellow-700/50 border-yellow-600'}`}>{wsHealthy ? 'Subscribed (WS Healthy)' : 'Subscribed (WS Idle)'}</span>
          ) : null}
        </div>
      </div>
      {!m ? <div className="text-sm opacity-70">Loading...</div> : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
          <div><div className="text-gray-400">Active Opps</div><div>{fmt(m.opportunities_active)}</div></div>
          <div><div className="text-gray-400">Max Profit (bps)</div><div>{fmt(m.max_profit_bps)}</div></div>
          <div><div className="text-gray-400">Avg Profit (bps)</div><div>{typeof m.avg_profit_bps === 'number' ? m.avg_profit_bps.toFixed(2) : '-'}</div></div>
          <div><div className="text-gray-400">Graph Nodes</div><div>{fmt(m.backend_graph_nodes ?? m.graph_nodes)}</div></div>
          <div><div className="text-gray-400">Graph Edges</div><div>{fmt(m.backend_graph_edges ?? m.graph_edges)}</div></div>
          <div><div className="text-gray-400">Last Detection</div><div>{ago(m.last_detection_ms)}</div></div>
          <div><div className="text-gray-400">Ingestion (ms)</div><div>{fmt(m.ingestion_duration_ms)}</div></div>
          <div><div className="text-gray-400">Detection (ms)</div><div>{fmt(m.detection_duration_ms)}</div></div>
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
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};


