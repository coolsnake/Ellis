import React, { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';

type FillerItem = { key: string; status: { running: boolean; fillsLastMin?: number } };

export const FillerStatus: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status, setStatus] = useState<{ fillers?: FillerItem[] } | null>(null);
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
    } catch {}
    finally {
      inflightRef.current = false;
    }
  };

  useEffect(() => {
    load();
    return () => { try { abortRef.current?.abort(); } catch {} };
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
            <div className="text-gray-200">{it.key} — {it.status?.running ? 'running' : 'stopped'} · fills(1m)={it.status?.fillsLastMin ?? 0}</div>
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


