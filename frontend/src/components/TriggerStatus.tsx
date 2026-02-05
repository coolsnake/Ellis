import React, { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocketExtraEvents } from '../app/hooks/useSocketExtraEvents';
import { Button, EmptyState } from './ui';

type TriggerItem = { key: string; status: { running: boolean; triggersLastMin?: number } };

export const TriggerStatus: React.FC<{ apiBase: string; hideHeader?: boolean }> = ({ apiBase, hideHeader = false }) => {
  const [status, setStatus] = useState<{ triggers?: TriggerItem[] } | null>(null);
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
      const res = await fetch(`${apiBase}${ROUTES.strategies.trigger.status}`, { signal: ac.signal });
      const data = await res.json();
      setStatus(data || null);
      clearTimeout(timeout);
      if (abortRef.current === ac) abortRef.current = null;
      inflightRef.current = false;
      const list = Array.isArray(data?.triggers) ? data.triggers as any[] : [];
      const ms: Record<string, any> = {};
      await Promise.all(list.map(async (it: any) => {
        try {
          const r = await fetch(`${apiBase}${ROUTES.strategies.trigger.metrics}?bot=${encodeURIComponent(it.key)}`);
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

  useSocketExtraEvents({
    onTriggerUpdate: async (payload: any) => {
      try {
        if (payload && typeof payload === 'object') {
          setStatus(payload);
          const list = Array.isArray(payload?.triggers) ? payload.triggers as any[] : [];
          const ms: Record<string, any> = {};
          await Promise.all(list.map(async (it: any) => {
            try {
              const r = await fetch(`${apiBase}${ROUTES.strategies.trigger.metrics}?bot=${encodeURIComponent(it.key)}`);
              ms[it.key] = await r.json();
            } catch {}
          }));
          setMetrics(ms);
        }
      } catch {}
    },
  });

  const triggersRef = useRef<TriggerItem[]>([]);
  useEffect(() => {
    triggersRef.current = Array.isArray(status?.triggers) ? status.triggers : [];
  }, [status?.triggers]);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const list = triggersRef.current;
        if (list.length === 0) return;
        const ms: Record<string, any> = {};
        await Promise.all(list.map(async (it: any) => {
          try {
            const r = await fetch(`${apiBase}${ROUTES.strategies.trigger.metrics}?bot=${encodeURIComponent(it.key)}&windowMs=60000`);
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
      const endpoint = (ROUTES as any).strategies.trigger[kind];
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

  const list = Array.isArray((status as any)?.triggers) ? ((status as any).triggers as TriggerItem[]) : [];

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Trigger Bots</h3>
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
                        Triggers (1m): <span className="text-white font-mono">{it.status?.triggersLastMin ?? 0}</span>
                      </span>
                    </div>
                    {m && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
                        <span>Attempts: <span className="text-white font-mono">{attempts}</span></span>
                        <span>Success: <span className="text-white font-mono">{successRate}%</span></span>
                        <span>Build: <span className="text-white font-mono">{avgBuildMs || '-'}ms</span></span>
                        <span>Latency: <span className="text-white font-mono">{avgLatencyMs || '-'}ms</span></span>
                        <span>Cost: <span className="text-white font-mono">{costSol.toFixed(6)} SOL</span></span>
                      </div>
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
        <EmptyState message="No trigger bots" />
      )}
    </div>
  );
};

export default TriggerStatus;
