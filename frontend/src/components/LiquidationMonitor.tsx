// @ts-nocheck
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useSocket } from '../app/contexts/socket';
import { StatCard, Button, EmptyState } from './ui';

type QueueItem = { userPk: string; health: number; updatedAt: number };
type UserItem = { userPk: string; health: number; updatedAt: number };

interface Props {
  apiBase: string;
  socket?: any;
  liquidatorKey?: string;
}

export const LiquidationMonitor: React.FC<Props> = ({ apiBase, socket, liquidatorKey = 'liq#default' }) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [queue, setQueue] = useState<{ candidatesQueued: number; top: QueueItem[]; markets: number[]; exposures?: Array<{ marketIndex: number; users: number; symbol?: string }>; actionsLastMin: number; errorsLastMin: number; users?: UserItem[] } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  const fetchQueue = useCallback(async () => {
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
  }, [apiBase, liquidatorKey]);

  const fetchQueueRef = useRef(fetchQueue);
  useEffect(() => {
    fetchQueueRef.current = fetchQueue;
  }, [fetchQueue]);

  useEffect(() => {
    fetchQueue();
    const id = setInterval(() => {
      fetchQueueRef.current();
    }, 10000);
    return () => clearInterval(id);
  }, [fetchQueue]);

  useEffect(() => {
    if (!effectiveSocket) return;
    const handler = (evt: any) => {
      try {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'queue' || evt.type === 'stats') {
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

  const testUser = async (userPk: string) => {
    try {
      await fetch(`${apiBase}/strategies/liquidator/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: liquidatorKey, userPk })
      });
      setTimeout(fetchQueue, 800);
    } catch {}
  };

  return (
    <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Liquidation Monitor</h3>
        <span className="text-xs text-gray-400">{lastUpdate ? `Updated ${timeAgo(lastUpdate)}` : ''}</span>
      </div>
      
      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard 
          label="Tracked Markets" 
          value={queue?.markets?.join(', ') || '-'}
        />
        <StatCard 
          label="Queued Candidates" 
          value={queue?.candidatesQueued ?? 0}
        />
        <StatCard 
          label="Actions (1m)" 
          value={queue?.actionsLastMin ?? 0}
        />
        <StatCard 
          label="Errors (1m)" 
          value={queue?.errorsLastMin ?? 0}
          className={((queue?.errorsLastMin || 0) > 0) ? 'border-yellow-600/30' : ''}
        />
      </div>

      {/* Market Exposures */}
      {Array.isArray(queue?.exposures) && queue!.exposures!.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-300 mb-2">Market Exposures</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {queue!.exposures!.map((e) => (
              <div key={`exp-${e.marketIndex}`} className="p-2 bg-gray-800/50 border border-gray-700/50 rounded-lg flex items-center justify-between">
                <span className="text-gray-300 text-sm">{e.symbol || e.marketIndex}</span>
                <span className="text-white font-mono text-sm">{e.users}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Users Under Threshold */}
      {Array.isArray(queue?.users) && queue!.users!.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-300 mb-2">Users Under Threshold</h4>
          <div className="space-y-2 max-h-80 overflow-auto">
            {queue!.users!.map((u) => (
              <div key={`user-${u.userPk}`} className="p-3 bg-gray-800/50 border border-gray-700/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-white font-mono text-sm" title={u.userPk}>
                      {u.userPk.slice(0, 4)}…{u.userPk.slice(-4)}
                    </span>
                    <span className="text-xs text-gray-400">health</span>
                    <span className={`font-mono text-sm ${u.health < -0.5 ? 'text-red-400' : u.health < 0 ? 'text-yellow-400' : 'text-white'}`}>
                      {formatPct(u.health)}
                    </span>
                    {typeof (u as any).profitability === 'number' && (
                      <>
                        <span className="text-xs text-gray-400">prof</span>
                        <span className={`font-mono text-sm ${(u as any).profitability > 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                          {(((u as any).profitability) * 100).toFixed(2)}%
                        </span>
                      </>
                    )}
                    {typeof (u as any).skipReason === 'string' && (u as any).skipReason && (
                      <span className="px-1.5 py-0.5 bg-gray-700 rounded text-[10px] uppercase tracking-wide text-gray-300">
                        {(u as any).skipReason}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Button size="xs" variant="primary" onClick={() => testUser(u.userPk)}>Test</Button>
                    <span className="text-xs text-gray-500">{timeAgo(u.updatedAt)}</span>
                  </div>
                </div>
                {Array.isArray((u as any).positions) && (u as any).positions.length > 0 && (
                  <div className="mt-2 ml-2 space-y-1 border-l-2 border-gray-700 pl-3">
                    {(u as any).positions.map((p: any) => (
                      <div key={`pos-${u.userPk}-${p.marketIndex}`} className="flex items-center gap-3 text-xs text-gray-400">
                        <span className="font-mono text-gray-300">{p.symbol ?? `m${p.marketIndex}`}</span>
                        <span>base <span className="text-white font-mono">{(p.base ?? 0).toFixed(3)}</span></span>
                        {typeof p.notional === 'number' && (
                          <span>notional <span className="text-white font-mono">${p.notional.toFixed(2)}</span></span>
                        )}
                        {typeof p.liqPrice === 'number' && (
                          <span>liq <span className="text-white font-mono">{p.liqPrice.toFixed(2)}</span></span>
                        )}
                        {typeof p.profitability === 'number' && (
                          <span>prof <span className={`font-mono ${p.profitability > 0 ? 'text-green-400' : 'text-yellow-400'}`}>{(p.profitability * 100).toFixed(2)}%</span></span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top At-Risk Accounts */}
      <div>
        <h4 className="text-sm font-medium text-gray-300 mb-2">Top At-Risk Accounts (health &lt; 0)</h4>
        {(queue?.top || []).length > 0 ? (
          <div className="space-y-1 max-h-56 overflow-auto">
            {(queue?.top || []).map((c) => (
              <div key={c.userPk} className="flex items-center justify-between p-2 bg-gray-800/50 border border-gray-700/50 rounded-lg text-sm">
                <div className="flex items-center gap-3">
                  <span className="text-white font-mono" title={c.userPk}>
                    {c.userPk.slice(0, 4)}…{c.userPk.slice(-4)}
                  </span>
                  <span className="text-xs text-gray-400">health</span>
                  <span className={`font-mono ${c.health < -0.5 ? 'text-red-400' : c.health < 0 ? 'text-yellow-400' : 'text-white'}`}>
                    {formatPct(c.health)}
                  </span>
                </div>
                <span className="text-xs text-gray-500">{timeAgo(c.updatedAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState message="No unhealthy users detected" />
        )}
      </div>
    </div>
  );
};

export default LiquidationMonitor;
