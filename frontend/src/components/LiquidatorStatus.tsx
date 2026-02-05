import React, { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useSocketExtraEvents } from '../app/hooks/useSocketExtraEvents';
import { Button, DataTable, DataTableRow, DataTableCell, EmptyState } from './ui';

type LiquidatorItem = { key: string; status: { running: boolean; actionsLastMin?: number; errorsLastMin?: number } };

export const LiquidatorStatus: React.FC<{ apiBase: string; hideHeader?: boolean }> = ({ apiBase, hideHeader = false }) => {
  const [status, setStatus] = useState<{ liquidators?: LiquidatorItem[] } | null>(null);
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
    // Periodic refresh as fallback for missed WebSocket events (2s for faster UI updates)
    const refreshId = setInterval(() => { load(); }, 2000);
    return () => { 
      try { abortRef.current?.abort(); } catch {} 
      try { clearInterval(refreshId); } catch {}
    };
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
      setTimeout(() => { try { load(); } catch {} }, 800);
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const list = Array.isArray(status?.liquidators) ? (status!.liquidators as LiquidatorItem[]) : [];

  useSocketExtraEvents({
    onLiquidatorUpdate: async (payload: any) => {
      try {
        if (payload && typeof payload === 'object') {
          setStatus(payload);
        }
      } catch {}
    },
  });

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Liquidators</h3>
          <Button onClick={load} disabled={busy}>Refresh</Button>
        </div>
      )}
      {list.length > 0 ? (
        <div className="space-y-2">
          {list.map((it) => {
            const a = Number(it.status?.actionsLastMin || 0);
            const e = Number(it.status?.errorsLastMin || 0);
            const successRate = a > 0 ? (((a - e) / a) * 100).toFixed(1) : '0.0';
            
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
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-xs text-gray-400">
                      <span title="Completed liquidation attempts (includes dry runs/tests)">Attempts (1m): <span className="text-white font-mono">{a}</span></span>
                      <span title="Attempt errors in the last minute">Errors (1m): <span className={e > 0 ? 'text-yellow-400 font-mono' : 'text-white font-mono'}>{e}</span></span>
                      <span>Success: <span className="text-white font-mono">{successRate}%</span></span>
                    </div>
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
        <EmptyState message="No liquidators" />
      )}
    </div>
  );
};

export default LiquidatorStatus;
