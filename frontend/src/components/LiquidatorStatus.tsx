import React, { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';

type LiquidatorItem = { key: string; status: { running: boolean; actionsLastMin?: number; errorsLastMin?: number } };

export const LiquidatorStatus: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status, setStatus] = useState<{ liquidators?: LiquidatorItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const inflightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = async () => {
    try {
      if (inflightRef.current) return;
      inflightRef.current = true;
      // Abort any previous pending request and set a timeout to avoid piling up
      try { abortRef.current?.abort(); } catch {}
      const ac = new AbortController();
      abortRef.current = ac;
      const timeout = setTimeout(() => { try { ac.abort('timeout'); } catch {} }, 2500);
      const res = await fetch(`${apiBase}${ROUTES.strategies.liquidator.status}`, { signal: ac.signal });
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
      const endpoint = (ROUTES as any).strategies.liquidator[kind];
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

  const list = Array.isArray(status?.liquidators) ? (status!.liquidators as LiquidatorItem[]) : [];

  return (
    <div className="bg-gray-800 rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-white font-semibold">Liquidator Status</h3>
        <button className="px-2 py-1 bg-gray-700 text-white rounded text-sm" onClick={load} disabled={busy}>Refresh</button>
      </div>
      <div className="space-y-2 text-sm">
        {list.map((it) => (
          <div key={it.key} className="p-2 bg-gray-700 rounded flex items-center justify-between">
            <div className="text-gray-200">{it.key} — {it.status?.running ? 'running' : 'stopped'} · actions(1m)={it.status?.actionsLastMin ?? 0} · errors(1m)={it.status?.errorsLastMin ?? 0}</div>
            <div className="space-x-2">
              <button className="px-2 py-1 bg-green-600 text-white rounded text-xs" onClick={() => act('start', it.key)} disabled={busy}>Start</button>
              <button className="px-2 py-1 bg-yellow-600 text-white rounded text-xs" onClick={() => act('stop', it.key)} disabled={busy}>Stop</button>
              <button className="px-2 py-1 bg-red-600 text-white rounded text-xs" onClick={() => act('remove', it.key)} disabled={busy}>Remove</button>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="text-gray-400">No liquidators</div>}
      </div>
    </div>
  );
};

export default LiquidatorStatus;


