import React, { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocketExtraEvents } from '../app/hooks/useSocketExtraEvents';

type FillerItem = { key: string; status: { running: boolean; fillsLastMin?: number } };

export const FillerStatus: React.FC<{ apiBase: string }> = ({ apiBase }) => {
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
      // Load metrics for each bot key (1m)
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
    return () => { try { abortRef.current?.abort(); } catch {} };
  }, [apiBase]);

  // Subscribe to socket updates so bots appear without manual refresh
  useSocketExtraEvents({
    onFillerUpdate: async (payload: any) => {
      try {
        if (payload && typeof payload === 'object') {
          setStatus(payload);
          // Refresh metrics for updated list
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

  // Background metrics refresh (not realtime): every 20s
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const list = Array.isArray(status?.fillers) ? status!.fillers as any[] : [];
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
    }, 20000);
    return () => { try { clearInterval(id); } catch {} };
  }, [apiBase, JSON.stringify(status?.fillers || [])]);

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
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const list = Array.isArray((status as any)?.fillers) ? ((status as any).fillers as FillerItem[]) : [];

  return (
    <div className="bg-gray-800 rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-white font-semibold">Filler Bots</h3>
        <button className="px-2 py-1 bg-gray-700 text-white rounded text-sm" onClick={load} disabled={busy}>Refresh</button>
      </div>
      <div className="space-y-2 text-sm">
        {list.map((it) => (
          <div key={it.key} className="p-2 bg-gray-700 rounded flex items-center justify-between">
            <div className="text-gray-200">
              <div>{it.key} — {it.status?.running ? 'running' : 'stopped'} · fills(1m)={it.status?.fillsLastMin ?? 0}</div>
              {metrics[it.key] && (
                <div className="text-xs text-gray-300 mt-0.5">
                  attempts(1m)={metrics[it.key].attempts ?? 0} · successes(1m)={metrics[it.key].successes ?? 0} · cost(1m)={(metrics[it.key].costSol ?? 0).toFixed(6)} SOL · revenue(1m)={(metrics[it.key].revenueQuote ?? 0).toLocaleString()} q
                </div>
              )}
              {(it.status as any)?.minMakerCountPerNode !== undefined && (
                <div className="text-xs text-gray-400 mt-0.5">
                  young={(it.status as any).skipYoungOrderMs ?? 0}ms · makers≥{(it.status as any).minMakerCountPerNode ?? 0} req={((it.status as any).requireExistingMakers ? 'Y' : 'N')} · tipFloorMin={(it.status as any).minTipFloorToAttemptLamports ?? 0} · jitTTL={(it.status as any).denyJitTakersTtlMs ?? 0}ms
                </div>
              )}
            </div>
            <div className="space-x-2">
              <button className="px-2 py-1 bg-green-600 text-white rounded text-xs" onClick={() => act('start', it.key)} disabled={busy}>Start</button>
              <button className="px-2 py-1 bg-yellow-600 text-white rounded text-xs" onClick={() => act('stop', it.key)} disabled={busy}>Stop</button>
              <button className="px-2 py-1 bg-red-600 text-white rounded text-xs" onClick={() => act('remove', it.key)} disabled={busy}>Remove</button>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="text-gray-400">No filler bots</div>}
      </div>
    </div>
  );
};

export default FillerStatus;


