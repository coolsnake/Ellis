// @ts-nocheck
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSocket } from '../app/contexts/socket';
import { StatCard, Button, EmptyState } from './ui';

type QueueItem = { userPk: string; health: number; updatedAt: number };
type UserItem = { userPk: string; health: number; updatedAt: number };
type MarketFee = { marketIndex: number; symbol?: string; perpFee?: number; spotFee?: number };
type LiqAttempt = { ts: number; type: string; marketIndex: number; user: string; sig?: string; ms: number; notionalUsd?: number; liqFeeRate?: number; ok: boolean; error?: string };

interface Props {
  apiBase: string;
  socket?: any;
  liquidatorKey?: string;
  hideUserList?: boolean;
}

export const LiquidationMonitor: React.FC<Props> = ({ apiBase, socket, liquidatorKey = 'liq#default', hideUserList = false }) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [queue, setQueue] = useState<{ candidatesQueued: number; top: QueueItem[]; markets: number[]; exposures?: Array<{ marketIndex: number; users: number; symbol?: string }>; actionsLastMin: number; errorsLastMin: number; users?: UserItem[]; marketFees?: MarketFee[]; recentAttempts?: LiqAttempt[] } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [marketsOpen, setMarketsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);

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
            marketFees: Array.isArray(evt.marketFees) ? evt.marketFees : [],
            recentAttempts: Array.isArray(evt.recentAttempts) ? evt.recentAttempts : [],
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

  // Group recent attempts by type
  const attemptsByType = useMemo(() => {
    const attempts = Array.isArray(queue?.recentAttempts) ? queue!.recentAttempts! : [];
    const grouped: Record<string, LiqAttempt[]> = {};
    for (const a of attempts) {
      const t = a.type || 'unknown';
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(a);
    }
    // Sort each group by timestamp descending (newest first)
    for (const t of Object.keys(grouped)) {
      grouped[t].sort((a, b) => b.ts - a.ts);
    }
    return grouped;
  }, [queue?.recentAttempts]);

  const attemptStats = useMemo(() => {
    const attempts = Array.isArray(queue?.recentAttempts) ? queue!.recentAttempts! : [];
    const total = attempts.length;
    const ok = attempts.filter(a => a.ok).length;
    const totalRevenue = attempts.reduce((sum, a) => {
      if (!a.ok || typeof a.notionalUsd !== 'number' || typeof a.liqFeeRate !== 'number') return sum;
      return sum + a.notionalUsd * a.liqFeeRate;
    }, 0);
    return { total, ok, failed: total - ok, totalRevenue };
  }, [queue?.recentAttempts]);

  const TYPE_LABELS: Record<string, string> = {
    perp: 'Perp',
    perp_batch: 'Perp Batch',
    perp_pnl_deposit: 'PnL Settle (Deposit)',
    perp_pnl_borrow: 'PnL Settle (Borrow)',
    spot: 'Spot',
  };

  const displayHealthMin = -0.02;
  const filteredUsers = useMemo(() => {
    try {
      const users = Array.isArray(queue?.users) ? [...queue!.users!] : [];
      return users.filter((u) => {
        if (typeof u?.health !== 'number') return false;
        if (u.health < 0) return u.health >= displayHealthMin;
        return true;
      });
    } catch {
      return [];
    }
  }, [queue?.users]);
  return (
    <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Liquidation Monitor</h3>
        <span className="text-xs text-gray-400">{lastUpdate ? `Updated ${timeAgo(lastUpdate)}` : ''}</span>
      </div>
      
      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="Queued Candidates" value={queue?.candidatesQueued ?? 0} />
        <StatCard label="Actions (1m)" value={queue?.actionsLastMin ?? 0} />
        <StatCard
          label="Errors (1m)"
          value={queue?.errorsLastMin ?? 0}
          className={((queue?.errorsLastMin || 0) > 0) ? 'border-yellow-600/30' : ''}
        />
      </div>

      {/* Tracked Markets with Fees (collapsible) */}
      {Array.isArray(queue?.marketFees) && queue!.marketFees!.length > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setMarketsOpen((v) => !v)}
            className="flex items-center gap-2 w-full text-left group"
          >
            <span className={`text-gray-400 transition-transform text-xs ${marketsOpen ? 'rotate-90' : ''}`}>&#9654;</span>
            <h4 className="text-sm font-medium text-gray-300">Tracked Markets</h4>
            <span className="text-xs text-gray-500">{queue!.marketFees!.length}</span>
          </button>
          {marketsOpen && (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs uppercase tracking-wide border-b border-gray-700/50">
                    <th className="text-left py-1.5 pr-4">Market</th>
                    <th className="text-right py-1.5 px-3">Perp Fee</th>
                    <th className="text-right py-1.5 px-3">Spot Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {queue!.marketFees!.map((mf) => (
                    <tr key={`mf-${mf.marketIndex}`} className="border-b border-gray-800/30">
                      <td className="py-1.5 pr-4 text-gray-200 font-mono">{mf.symbol || `#${mf.marketIndex}`}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-gray-300">
                        {typeof mf.perpFee === 'number' ? `${(mf.perpFee * 100).toFixed(2)}%` : '-'}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono text-gray-300">
                        {typeof mf.spotFee === 'number' ? `${(mf.spotFee * 100).toFixed(2)}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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

      {/* Liquidation Attempts */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-medium text-gray-300">Liquidation Attempts</h4>
          {attemptStats.total > 0 && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-gray-400">{attemptStats.total} total</span>
              <span className="text-green-400">{attemptStats.ok} ok</span>
              {attemptStats.failed > 0 && <span className="text-red-400">{attemptStats.failed} failed</span>}
              {attemptStats.totalRevenue > 0 && (
                <span className="text-emerald-400 font-mono">~${attemptStats.totalRevenue.toFixed(4)} est. rev</span>
              )}
            </div>
          )}
        </div>
        {Object.keys(attemptsByType).length === 0 ? (
          <EmptyState message="No recent liquidation attempts" />
        ) : (
          <div className="space-y-3">
            {Object.entries(attemptsByType).map(([type, attempts]) => (
              <div key={`atype-${type}`} className="bg-gray-800/30 border border-gray-700/40 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800/60 border-b border-gray-700/40">
                  <span className="text-xs font-medium text-gray-200 uppercase tracking-wide">{TYPE_LABELS[type] || type}</span>
                  <span className="text-xs text-gray-400">{attempts.length}</span>
                </div>
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 uppercase tracking-wide">
                        <th className="text-left py-1 px-2">Time</th>
                        <th className="text-left py-1 px-2">User</th>
                        <th className="text-right py-1 px-2">Mkt</th>
                        <th className="text-right py-1 px-2">Notional</th>
                        <th className="text-right py-1 px-2">Fee</th>
                        <th className="text-right py-1 px-2">Est Rev</th>
                        <th className="text-right py-1 px-2">ms</th>
                        <th className="text-center py-1 px-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((a, i) => {
                        const estRev = (a.ok && typeof a.notionalUsd === 'number' && typeof a.liqFeeRate === 'number')
                          ? a.notionalUsd * a.liqFeeRate
                          : null;
                        return (
                          <tr key={`att-${type}-${i}`} className="border-t border-gray-800/30 hover:bg-gray-800/40">
                            <td className="py-1 px-2 text-gray-400 font-mono">{timeAgo(a.ts)}</td>
                            <td className="py-1 px-2 text-gray-300 font-mono" title={a.user}>
                              {a.user?.slice(0, 4)}…{a.user?.slice(-4)}
                            </td>
                            <td className="py-1 px-2 text-right text-gray-300 font-mono">{a.marketIndex}</td>
                            <td className="py-1 px-2 text-right font-mono text-gray-300">
                              {typeof a.notionalUsd === 'number' ? `$${a.notionalUsd.toFixed(2)}` : '-'}
                            </td>
                            <td className="py-1 px-2 text-right font-mono text-gray-400">
                              {typeof a.liqFeeRate === 'number' ? `${(a.liqFeeRate * 100).toFixed(2)}%` : '-'}
                            </td>
                            <td className="py-1 px-2 text-right font-mono">
                              {estRev !== null
                                ? <span className="text-emerald-400">${estRev.toFixed(4)}</span>
                                : <span className="text-gray-600">-</span>}
                            </td>
                            <td className="py-1 px-2 text-right font-mono text-gray-400">{a.ms}</td>
                            <td className="py-1 px-2 text-center">
                              {a.ok ? (
                                a.sig ? (
                                  <a
                                    href={`https://solscan.io/tx/${a.sig}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-green-400 hover:text-green-300 underline"
                                    title={a.sig}
                                  >
                                    ok
                                  </a>
                                ) : (
                                  <span className="text-green-400">ok</span>
                                )
                              ) : (
                                <span className="text-red-400 cursor-help" title={a.error || 'failed'}>err</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Users Under Threshold (collapsible) */}
      {!hideUserList && filteredUsers.length > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setUsersOpen((v) => !v)}
            className="flex items-center gap-2 w-full text-left group"
          >
            <span className={`text-gray-400 transition-transform text-xs ${usersOpen ? 'rotate-90' : ''}`}>&#9654;</span>
            <h4 className="text-sm font-medium text-gray-300">Users Under Threshold</h4>
            <span className="text-xs text-gray-500">{filteredUsers.length}</span>
          </button>
          {usersOpen && (
          <>
          <div className="text-xs text-gray-500 mb-2 mt-2">Showing all under-threshold users; for sub-0, only down to -2%</div>
          <div className="space-y-2 max-h-80 overflow-auto">
            {filteredUsers.map((u) => (
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
                        <span className="text-xs text-gray-400">est prof</span>
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
                    <Button
                      size="xs"
                      variant="primary"
                      title="Runs full liquidation test (bypasses exec gate + guards; minimal size/cap; respects dry run)"
                      onClick={() => testUser(u.userPk)}
                    >
                      Attempt
                    </Button>
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
                          <span>est prof <span className={`font-mono ${p.profitability > 0 ? 'text-green-400' : 'text-yellow-400'}`}>{(p.profitability * 100).toFixed(2)}%</span></span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
          )}
        </div>
      )}
    </div>
  );
};

export default LiquidationMonitor;
