// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { useSocket } from '../app/contexts/socket';

type QueueItem = { userPk: string; health: number; updatedAt: number };
type UserItem = { userPk: string; health: number; updatedAt: number };

interface Props {
  apiBase: string;
  socket?: any;
  liquidatorKey?: string; // e.g., 'liq#default'
}

export const LiquidationMonitor: React.FC<Props> = ({ apiBase, socket, liquidatorKey = 'liq#default' }) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [queue, setQueue] = useState<{ candidatesQueued: number; top: QueueItem[]; markets: number[]; exposures?: Array<{ marketIndex: number; users: number; symbol?: string }>; actionsLastMin: number; errorsLastMin: number; users?: UserItem[] } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  const fetchQueue = async () => {
    try {
      const url = `${apiBase}/strategies/liquidator/queue?key=${encodeURIComponent(liquidatorKey)}&limit=25`;
      const res = await fetch(url);
      const data = await res.json();
      const q = (data?.queue || null) as any;
      if (q) {
        setQueue(q);
        setLastUpdate(Date.now());
      }
    } catch {}
  };

  useEffect(() => {
    fetchQueue();
    const id = setInterval(fetchQueue, 3000);
    return () => clearInterval(id);
  }, [apiBase, liquidatorKey]);

  useEffect(() => {
    if (!effectiveSocket) return;
    const handler = (evt: any) => {
      try {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'queue' || evt.type === 'stats') {
          // Debounce UI updates to at most ~1 Hz
          const now = Date.now();
          if (lastUpdate && (now - lastUpdate) < 750) return;
          setQueue({
            candidatesQueued: Number(evt.candidatesQueued || 0),
            top: Array.isArray(evt.top) ? evt.top : [],
            markets: Array.isArray(evt.markets) ? evt.markets : [],
            exposures: Array.isArray(evt.exposures) ? evt.exposures : [],
            actionsLastMin: Number(evt.actionsLastMin || 0),
            errorsLastMin: Number(evt.errorsLastMin || 0),
            users: Array.isArray(evt.users) ? evt.users : [],
          });
          setLastUpdate(now);
        }
      } catch {}
    };
    effectiveSocket.on('drift-liquidation', handler);
    return () => { try { effectiveSocket.off('drift-liquidation', handler); } catch {} };
  }, [effectiveSocket]);

  const formatPct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const timeAgo = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 1000) return 'now';
    if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
    return `${Math.floor(d / 60000)}m ago`;
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Liquidation Monitor</h3>
        <div className="text-xs text-gray-400">{lastUpdate ? `Updated ${timeAgo(lastUpdate)}` : ''}</div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
        <div>
          <div className="text-gray-400">Tracked Markets</div>
          <div className="text-white font-mono">{queue?.markets?.join(', ') || '-'}</div>
        </div>
        <div>
          <div className="text-gray-400">Queued Candidates</div>
          <div className="text-white font-mono">{queue?.candidatesQueued ?? 0}</div>
        </div>
        <div>
          <div className="text-gray-400">Actions (1m)</div>
          <div className="text-white font-mono">{queue?.actionsLastMin ?? 0}</div>
        </div>
        <div>
          <div className="text-gray-400">Errors (1m)</div>
          <div className={`font-mono ${((queue?.errorsLastMin || 0) > 0) ? 'text-yellow-300' : 'text-white'}`}>{queue?.errorsLastMin ?? 0}</div>
        </div>
      </div>

      {Array.isArray(queue?.exposures) && (queue!.exposures!.length > 0) && (
        <div className="mb-3">
          <div className="text-gray-300 mb-1 text-sm">Market Exposures (users with open perp positions)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {queue!.exposures!.map((e) => (
              <div key={`exp-${e.marketIndex}`} className="p-2 bg-gray-700 rounded flex items-center justify-between">
                <span className="text-gray-300">{e.symbol || e.marketIndex}</span>
                <span className="text-white font-mono">{e.users}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(queue?.users) && (queue!.users!.length > 0) && (
        <div className="mb-3">
          <div className="text-gray-300 mb-1 text-sm">Users Under Threshold (actively monitored)</div>
          <div className="space-y-1 max-h-56 overflow-auto">
            {queue!.users!.map((u) => (
              <div key={`user-${u.userPk}`} className="flex items-center justify-between p-2 bg-gray-700 rounded text-xs">
                <div className="flex items-center space-x-2">
                  <span className="text-white font-mono" title={u.userPk}>{u.userPk.slice(0, 4)}…{u.userPk.slice(-4)}</span>
                  <span className="text-gray-400">health</span>
                  <span className={`font-mono ${u.health < -0.5 ? 'text-red-300' : u.health < 0 ? 'text-yellow-300' : 'text-white'}`}>{formatPct(u.health)}</span>
                </div>
                <div className="text-gray-400">{timeAgo(u.updatedAt)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2">
        <div className="text-gray-300 mb-2 text-sm">Top At-Risk Accounts (health &lt; 0)</div>
        <div className="space-y-1 max-h-56 overflow-auto">
          {(queue?.top || []).map((c) => (
            <div key={`${c.userPk}`} className="flex items-center justify-between p-2 bg-gray-700 rounded text-xs">
              <div className="flex items-center space-x-2">
                <span className="text-white font-mono" title={c.userPk}>{c.userPk.slice(0, 4)}…{c.userPk.slice(-4)}</span>
                <span className="text-gray-400">health</span>
                <span className={`font-mono ${c.health < -0.5 ? 'text-red-300' : c.health < 0 ? 'text-yellow-300' : 'text-white'}`}>{formatPct(c.health)}</span>
              </div>
              <div className="text-gray-400">{timeAgo(c.updatedAt)}</div>
            </div>
          ))}
          {(queue?.top?.length || 0) === 0 && (
            <div className="text-gray-400 text-xs">No unhealthy users detected</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LiquidationMonitor;


