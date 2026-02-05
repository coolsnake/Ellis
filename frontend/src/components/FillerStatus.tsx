import React, { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocketExtraEvents } from '../app/hooks/useSocketExtraEvents';
import { Button, EmptyState } from './ui';

type FillerItem = { key: string; status: { running: boolean; fillsLastMin?: number } };

export const FillerStatus: React.FC<{ apiBase: string; hideHeader?: boolean }> = ({ apiBase, hideHeader = false }) => {
  const [status, setStatus] = useState<{ fillers?: FillerItem[] } | null>(null);
  const [metrics, setMetrics] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const inflightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = async () => {
    try {
      if (inflightRef.current) return;
      inflightRef.current = true;
      try { abortRef.current?.abort(); } catch {}
      const ac = new AbortController();
      abortRef.current = ac;
      const timeout = setTimeout(() => { try { ac.abort('timeout'); } catch {} }, 2500);
      const res = await fetch(`${apiBase}${ROUTES.strategies.filler.status}`, { signal: ac.signal });
      const data = await res.json();
      setStatus(data || null);
      clearTimeout(timeout);
      if (abortRef.current === ac) abortRef.current = null;
      inflightRef.current = false;
      const list = Array.isArray(data?.fillers) ? data.fillers as any[] : [];
      const ms: Record<string, any> = {};
      await Promise.all(list.map(async (it: any) => {
        try {
          const r = await fetch(`${apiBase}${ROUTES.strategies.filler.metrics}?bot=${encodeURIComponent(it.key)}`);
          ms[it.key] = await r.json();
        } catch {}
      }));
      setMetrics(ms);
    } catch {}
    finally {
      inflightRef.current = false;
    }
  };

  useEffect(() => {
    load();
    // Periodic refresh as fallback for missed WebSocket events (2s for faster UI updates)
    const refreshId = setInterval(() => { load(); }, 2000);
    return () => { 
      try { abortRef.current?.abort(); } catch {} 
      try { clearInterval(refreshId); } catch {}
    };
  }, [apiBase]);

  useSocketExtraEvents({
    onFillerUpdate: async (payload: any) => {
      try {
        if (payload && typeof payload === 'object') {
          setStatus(payload);
          const list = Array.isArray(payload?.fillers) ? payload.fillers as any[] : [];
          const ms: Record<string, any> = {};
          await Promise.all(list.map(async (it: any) => {
            try {
              const r = await fetch(`${apiBase}${ROUTES.strategies.filler.metrics}?bot=${encodeURIComponent(it.key)}`);
              ms[it.key] = await r.json();
            } catch {}
          }));
          setMetrics(ms);
        }
      } catch {}
    },
  });

  const fillersRef = useRef<FillerItem[]>([]);
  useEffect(() => {
    fillersRef.current = Array.isArray(status?.fillers) ? status.fillers : [];
  }, [status?.fillers]);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const list = fillersRef.current;
        if (list.length === 0) return;
        const ms: Record<string, any> = {};
        await Promise.all(list.map(async (it: any) => {
          try {
            const r = await fetch(`${apiBase}${ROUTES.strategies.filler.metrics}?bot=${encodeURIComponent(it.key)}&windowMs=60000`);
            ms[it.key] = await r.json();
          } catch {}
        }));
        setMetrics(ms);
      } catch {}
    }, 30000);
    return () => { try { clearInterval(id); } catch {} };
  }, [apiBase]);

  const act = async (kind: 'start' | 'stop' | 'remove', key: string) => {
    try {
      setBusy(true);
      const endpoint = (ROUTES as any).strategies.filler[kind];
      await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      await load();
      setTimeout(() => { try { load(); } catch {} }, 800);
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const list = Array.isArray((status as any)?.fillers) ? ((status as any).fillers as FillerItem[]) : [];

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Filler Bots</h3>
          <Button onClick={load} disabled={busy}>Refresh</Button>
        </div>
      )}
      {list.length > 0 ? (
        <div className="space-y-2">
          {list.map((it) => {
            const m = metrics[it.key];
            const attempts = Number(m?.attempts ?? 0);
            const successes = Number(m?.successes ?? 0);
            const successRate = attempts > 0 ? ((successes / attempts) * 100).toFixed(1) : '0.0';
            const avgBuildMs = Number(m?.avgBuildMs ?? m?.avgBuildTimeMs ?? 0);
            const avgLatencyMs = Number(m?.avgLatencyMs ?? 0);
            const costSol = Number(m?.costSol ?? 0);
            const revenue = Number(m?.revenueQuote ?? 0);
            const last = (it.status as any)?.lastLoop;
            const econ = last?.econ;
            const prebuildStats = (it.status as any)?.prebuildStats;
            const prebuildCache = Number((it.status as any)?.prebuildCache ?? 0);
            
            return (
              <div key={it.key} className="p-3 bg-gray-700/50 border border-gray-600/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <span className={`w-2 h-2 rounded-full ${it.status?.running ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-gray-500'}`} />
                      <span className="text-white font-medium">{it.key}</span>
                      <span className={`px-2 py-0.5 rounded text-xs ${it.status?.running ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
                        {it.status?.running ? 'Running' : 'Stopped'}
                      </span>
                      <span className="text-xs text-gray-400">
                        Fills (1m): <span className="text-white font-mono">{it.status?.fillsLastMin ?? 0}</span>
                      </span>
                    </div>
                    {m && (
                      <>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
                          <span>Attempts: <span className="text-white font-mono">{attempts}</span></span>
                          <span>Success: <span className="text-white font-mono">{successRate}%</span></span>
                          <span>Build: <span className="text-white font-mono">{avgBuildMs || '-'}ms</span></span>
                          <span>Latency: <span className="text-white font-mono">{avgLatencyMs || '-'}ms</span></span>
                          <span>Cost: <span className="text-white font-mono">{costSol.toFixed(6)} SOL</span></span>
                          <span>Revenue: <span className="text-white font-mono">{revenue.toLocaleString()} q</span></span>
                        </div>
                        {(it.status as any)?.minMakerCountPerNode !== undefined && (
                          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                            <span>Young: <span className="text-gray-400 font-mono">{(it.status as any).skipYoungOrderMs ?? 0}ms</span></span>
                            <span>Makers: <span className="text-gray-400 font-mono">≥{(it.status as any).minMakerCountPerNode ?? 0}</span></span>
                            <span>Req: <span className="text-gray-400 font-mono">{(it.status as any).requireExistingMakers ? 'Y' : 'N'}</span></span>
                            <span>Tip Floor: <span className="text-gray-400 font-mono">{(it.status as any).minTipFloorToAttemptLamports ?? 0}</span></span>
                            <span>JIT TTL: <span className="text-gray-400 font-mono">{(it.status as any).denyJitTakersTtlMs ?? 0}ms</span></span>
                            <span>Min Notional: <span className="text-gray-400 font-mono">{(it.status as any).minNotionalQuote ?? 0}</span></span>
                            <span>Min Profit: <span className="text-gray-400 font-mono">{(it.status as any).minProfitQuote ?? 0}</span></span>
                            <span>Rank: <span className="text-gray-400 font-mono">{(it.status as any).rankBy || '-'}</span></span>
                          </div>
                        )}
                        {last && (
                          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                            <span>Loop: <span className="text-gray-400 font-mono">{last.nodesPlanned ?? 0}/{last.nodesProcessed ?? 0}/{last.nodesSent ?? 0}</span></span>
                            {!!econ?.count && (
                              <>
                                <span>Notional avg: <span className="text-gray-400 font-mono">{Number(econ.avgNotional ?? 0).toFixed(2)}</span></span>
                                <span>Reward avg: <span className="text-gray-400 font-mono">{Number(econ.avgReward ?? 0).toFixed(4)}</span></span>
                                <span>Profit avg: <span className="text-gray-400 font-mono">{Number(econ.avgProfit ?? 0).toFixed(4)}</span></span>
                              </>
                            )}
                            {(prebuildStats || prebuildCache) && (
                              <span>Prebuild: <span className="text-gray-400 font-mono">cache {prebuildCache} built {prebuildStats?.built ?? 0} hit {prebuildStats?.hit ?? 0} miss {prebuildStats?.miss ?? 0} exp {prebuildStats?.expired ?? 0}</span></span>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="xs" variant="success" onClick={() => act('start', it.key)} disabled={busy}>Start</Button>
                    <Button size="xs" variant="warning" onClick={() => act('stop', it.key)} disabled={busy}>Stop</Button>
                    <Button size="xs" variant="danger" onClick={() => act('remove', it.key)} disabled={busy}>Remove</Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message="No filler bots" />
      )}
    </div>
  );
};

export default FillerStatus;
