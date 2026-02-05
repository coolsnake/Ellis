import React, { useState, useEffect } from 'react';
import { logger } from '../utils/logger';
import { Panel, StatCard, Button, DataTable, DataTableRow, DataTableCell, EmptyState } from './ui';

interface GridLevel {
  id: string;
  price: number;
  side: 'buy' | 'sell';
  amount: number;
  filled: boolean;
  filledAt?: number;
  filledPrice?: number;
  filledAmount?: number;
  transactionSignature?: string;
  pnl?: number;
}

interface GridPosition {
  id: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  filledAmount: number;
  pnl: number;
  openedAt: number;
  closedAt?: number;
  transactionSignature?: string;
  exitTransactionSignature?: string;
  status: 'pending' | 'filled' | 'closed' | 'failed';
  strategyName?: string;
  pairedPositionId?: string;
  intention?: string;
  timeSinceOpen?: number;
  plannedExitSide?: 'buy' | 'sell';
  plannedExitLevelId?: string;
  plannedExitPrice?: number;
  plannedExitQtyIn?: number;
  plannedExitQtyOutEst?: number;
}

interface GridState {
  centerPrice: number;
  originalCenterPrice: number;
  lastRebalance: number;
  volatility: number;
  totalFilled: number;
  totalPnl: number;
  completedCycles: number;
  totalTrades: number;
}

interface GridMonitorProps {
  strategyName: string;
  apiBase: string;
  currentPrice?: number;
  showDetails?: boolean;
  isDrift?: boolean;
}

export const GridMonitor: React.FC<GridMonitorProps> = ({ strategyName, apiBase, currentPrice, showDetails = false, isDrift = false }) => {
  const [levels, setLevels] = useState<GridLevel[]>([]);
  const [positions, setPositions] = useState<GridPosition[]>([]);
  const [activePositions, setActivePositions] = useState<GridPosition[]>([]);
  const [tradeHistory, setTradeHistory] = useState<GridPosition[]>([]);
  const [state, setState] = useState<GridState | null>(null);
  const [performance, setPerformance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tokens, setTokens] = useState<{fromToken: string, toToken: string, fromSymbol: string, toSymbol: string, fromUsd?: number | null, toUsd?: number | null} | null>(null);
  const [driftInfo, setDriftInfo] = useState<{ spread?: number; fundingApy?: number; feeBps?: number; feeEstRoundTrip?: number; openOrders?: number; effectiveLeverage?: number; liquidationBuffer?: number } | null>(null);
  const [onlyClose, setOnlyClose] = useState<boolean>(false);
  const [showLevelsDetail, setShowLevelsDetail] = useState(false);
  const [showPositionsDetail, setShowPositionsDetail] = useState(false);
  const [showHistoryDetail, setShowHistoryDetail] = useState(false);

  const formatAmount = (n: number | undefined | null) => {
    const v = Number(n || 0);
    return v.toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  };

  const formatPrice = (n: number | undefined | null) => {
    const v = Math.abs(Number(n || 0));
    const maxFrac = v >= 100 ? 2 : v >= 10 ? 3 : v >= 1 ? 4 : 6;
    const minFrac = v >= 100 ? 2 : v >= 10 ? 3 : v >= 1 ? 4 : 6;
    return v.toLocaleString(undefined, { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac });
  };

  const formatUsd = (n: number | undefined | null) => {
    const v = Number(n || 0);
    if (!isFinite(v) || v <= 0) return 'N/A';
    return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatDuration = (timeMs: number) => {
    const totalSeconds = Math.floor(timeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatPriceUsdFromPair = (pairPrice: number | undefined | null) => {
    const p = Number(pairPrice || 0);
    if (!tokens?.fromUsd || !isFinite(p) || p <= 0) return formatPrice(pairPrice);
    return formatUsd(tokens.fromUsd * p);
  };

  const fetchGridData = async () => {
    try {
      const response = await fetch(`${apiBase}/grid/levels/${strategyName}`);
      const data = await response.json();
      setLevels(data.levels || []);
      setPositions(data.positions || []);
      setActivePositions(data.activePositions || []);
      setTradeHistory(data.tradeHistory || []);
      setState(data.state || null);
      setTokens(data.tokens || null);
      try { setOnlyClose(!!(data.controls?.onlyClose)); } catch {}
      if (data && (data.spread !== undefined || data.fundingApy !== undefined || data.feeBps !== undefined || data.feeEstRoundTrip !== undefined || data.openOrders !== undefined || data.effectiveLeverage !== undefined || data.liquidationBuffer !== undefined)) {
        setDriftInfo({ spread: data.spread, fundingApy: data.fundingApy, feeBps: data.feeBps, feeEstRoundTrip: data.feeEstRoundTrip, openOrders: data.openOrders, effectiveLeverage: data.effectiveLeverage, liquidationBuffer: data.liquidationBuffer });
      }
    } catch (error) {
      logger.error('Failed to fetch grid data:', error);
    }
  };

  const fetchPerformance = async () => {
    try {
      const response = await fetch(`${apiBase}/grid/performance/${strategyName}`);
      const data = await response.json();
      setPerformance(data);
    } catch (error) {
      logger.error('Failed to fetch performance data:', error);
    }
  };

  const rebalanceGrid = async () => {
    try {
      await fetch(`${apiBase}/grid/rebalance/${strategyName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ centerPrice: currentPrice })
      });
      await fetchGridData();
    } catch (error) {
      logger.error('Failed to rebalance grid:', error);
    }
  };

  const toggleOnlyClose = async (next: boolean) => {
    try {
      await fetch(`${apiBase}/strategy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: strategyName, onlyClose: next })
      });
      setOnlyClose(next);
      await fetchGridData();
    } catch (error) {
      logger.error('Failed to toggle only close:', error);
    }
  };

  const handleClosePosition = async (positionId: string) => {
    try {
      const response = await fetch(`${apiBase}/grid/close-position/${strategyName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId })
      });
      
      if (response.ok) {
        setActivePositions(prev => prev.filter(pos => pos.id !== positionId));
        await fetchGridData();
        logger.debug('Position closed successfully');
      } else {
        const errorData = await response.json();
        logger.error('Failed to close position:', errorData.error);
      }
    } catch (error) {
      logger.error('Failed to close position:', error);
    }
  };

  useEffect(() => {
    fetchGridData();
    fetchPerformance();
    const interval = setInterval(() => {
      fetchGridData();
      fetchPerformance();
    }, 1000);
    
    setLoading(false);
    return () => clearInterval(interval);
  }, [strategyName, apiBase]);

  if (loading) {
    return <div className="text-white">Loading grid data...</div>;
  }

  const buyLevels = levels.filter(l => l.side === 'buy').sort((a, b) => b.price - a.price);
  const sellLevels = levels.filter(l => l.side === 'sell').sort((a, b) => b.price - a.price);
  const filledLevels = levels.filter(l => l.filled);
  const minPrice = levels.length ? Math.min(...levels.map(l => l.price)) : undefined;
  const maxPrice = levels.length ? Math.max(...levels.map(l => l.price)) : undefined;
  const buyOnly = levels.filter(l => l.side === 'buy');
  const buyLevelAmount = buyOnly.length ? (buyOnly.reduce((sum, l) => sum + (l.amount || 0), 0) / buyOnly.length) : undefined;

  const averageCycleDurationMs = (() => {
    if (!tradeHistory || tradeHistory.length === 0) return undefined as number | undefined;
    const groups = tradeHistory.reduce((acc, p) => {
      const key = p.pairedPositionId || p.id;
      (acc[key] = acc[key] || []).push(p);
      return acc;
    }, {} as Record<string, GridPosition[]>);
    const durations: number[] = [];
    Object.values(groups).forEach(group => {
      const buy = group.find(g => g.side === 'buy');
      const sell = group.find(g => g.side === 'sell');
      if (!buy || !sell) return;
      const startTs = Math.min(buy.openedAt || 0, sell.openedAt || 0);
      const endTs = Math.max(buy.closedAt || 0, sell.closedAt || 0);
      if (endTs > startTs && startTs > 0) durations.push(endTs - startTs);
    });
    if (durations.length === 0) return undefined;
    return durations.reduce((a, b) => a + b, 0) / durations.length;
  })();

  // Calculate max amount for depth visualization
  const maxAmount = Math.max(...levels.map(l => l.amount || 0), 1);

  return (
    <div className="space-y-4">
      {/* Grid Overview */}
      <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">Grid Overview</h3>
          <div className="flex items-center gap-3">
            <label className="flex items-center text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                className="mr-2 rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500"
                checked={!!onlyClose}
                onChange={(e) => toggleOnlyClose(e.target.checked)}
              />
              Only close (no new buys)
            </label>
            <Button onClick={rebalanceGrid}>Rebalance</Button>
          </div>
        </div>
        
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <StatCard
            label="Center Price"
            value={typeof state?.centerPrice === 'number' ? formatPrice(state?.centerPrice) : 'N/A'}
          />
          <StatCard
            label="Current Price"
            value={typeof currentPrice === 'number' ? formatPrice(currentPrice) : (typeof state?.centerPrice === 'number' ? formatPrice(state?.centerPrice) : 'N/A')}
          />
          <StatCard
            label="Total Levels"
            value={levels.length}
          />
          <StatCard
            label="Filled Levels"
            value={filledLevels.length}
          />
        </div>
        
        {/* Strategy Info */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-gray-400 uppercase tracking-wider">Pair</div>
              <div className="text-white font-mono mt-1">{(() => {
                const to = tokens?.toSymbol || tokens?.toToken;
                if (isDrift && to && /-PERP/i.test(to)) return to;
                return `${tokens?.fromSymbol || tokens?.fromToken || 'FROM'} → ${tokens?.toSymbol || tokens?.toToken || 'TO'}`;
              })()}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase tracking-wider">Amount / Level</div>
              <div className="text-white font-mono mt-1">{buyLevelAmount !== undefined ? formatAmount(buyLevelAmount) : 'N/A'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase tracking-wider">Grid Range</div>
              <div className="text-white font-mono mt-1">{minPrice !== undefined && maxPrice !== undefined ? `${formatPrice(minPrice)} → ${formatPrice(maxPrice)}` : 'N/A'}</div>
            </div>
          </div>
          
          {/* Drift-specific metrics */}
          {isDrift && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm mt-4 pt-4 border-t border-gray-700/50">
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Spread</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.spread === 'number' ? formatPrice(driftInfo.spread) : 'N/A'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Funding APY</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.fundingApy === 'number' ? `${(driftInfo.fundingApy * 100).toFixed(2)}%` : 'N/A'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Fees (bps)</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.feeBps === 'number' ? driftInfo.feeBps : 'N/A'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Est. RT Fees</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.feeEstRoundTrip === 'number' ? formatAmount(driftInfo.feeEstRoundTrip) : 'N/A'}</div>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm mt-3">
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Open Orders</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.openOrders === 'number' ? driftInfo.openOrders : 'N/A'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Eff. Leverage</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.effectiveLeverage === 'number' ? driftInfo.effectiveLeverage.toFixed(2) : 'N/A'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Liq Buffer</div>
                  <div className="text-white font-mono mt-1">{typeof driftInfo?.liquidationBuffer === 'number' && isFinite(driftInfo.liquidationBuffer) ? `${(driftInfo.liquidationBuffer * 100).toFixed(2)}%` : (driftInfo?.liquidationBuffer === Infinity ? '∞' : 'N/A')}</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Performance Metrics */}
      <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
        <h3 className="text-lg font-semibold text-white mb-4">Performance</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Total PnL"
            value={(state?.totalPnl || 0).toFixed(4)}
            className={`${(state?.totalPnl || 0) >= 0 ? 'border-green-600/30' : 'border-red-600/30'}`}
          />
          <StatCard
            label="Completed Cycles"
            value={state?.completedCycles || 0}
          />
          <StatCard
            label="Total Trades"
            value={state?.totalTrades || 0}
          />
          <StatCard
            label="Active Positions"
            value={activePositions.length}
          />
        </div>
        <div className="mt-4 pt-4 border-t border-gray-700/50">
          <div className="text-sm">
            <span className="text-gray-400">Avg Cycle Time:</span>
            <span className="text-white font-mono ml-2">{averageCycleDurationMs !== undefined ? formatDuration(averageCycleDurationMs) : 'N/A'}</span>
          </div>
        </div>
      </div>

      {/* Grid Levels - Order Book Style */}
      {(showDetails || showLevelsDetail) && (
        <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Grid Levels</h3>
            <Button size="xs" onClick={() => setShowLevelsDetail(!showLevelsDetail)}>
              {showLevelsDetail ? 'Collapse' : 'Expand'}
            </Button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Sell Levels */}
            <div>
              <h4 className="text-sm font-medium text-green-400 mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500"></span>
                Sell Levels (Above Center)
              </h4>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {sellLevels.map((level) => {
                  const depthPercent = ((level.amount || 0) / maxAmount) * 100;
                  return (
                    <div
                      key={level.id}
                      className={`flex items-center text-xs h-7 hover:bg-white/5 relative group rounded ${
                        level.filled ? 'bg-green-900/30' : ''
                      }`}
                    >
                      <div 
                        className="absolute right-0 top-0 bottom-0 bg-green-900/20 rounded-r" 
                        style={{ width: `${depthPercent}%` }} 
                      />
                      <div className="w-24 font-mono text-green-400 relative z-10 pl-2">{formatPrice(level.price)}</div>
                      <div className="flex-1 text-right text-gray-300 relative z-10 pr-2 font-mono">{formatAmount(level.amount)}</div>
                      <div className={`w-16 text-right relative z-10 pr-2 text-[10px] uppercase ${level.filled ? 'text-green-400' : 'text-gray-500'}`}>
                        {level.filled ? 'Filled' : 'Open'}
                      </div>
                    </div>
                  );
                })}
                {sellLevels.length === 0 && <div className="text-gray-500 text-sm py-2">No sell levels</div>}
              </div>
            </div>

            {/* Buy Levels */}
            <div>
              <h4 className="text-sm font-medium text-red-400 mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500"></span>
                Buy Levels (Below Center)
              </h4>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {buyLevels.map((level) => {
                  const depthPercent = ((level.amount || 0) / maxAmount) * 100;
                  return (
                    <div
                      key={level.id}
                      className={`flex items-center text-xs h-7 hover:bg-white/5 relative group rounded ${
                        level.filled ? 'bg-red-900/30' : ''
                      }`}
                    >
                      <div 
                        className="absolute left-0 top-0 bottom-0 bg-red-900/20 rounded-l" 
                        style={{ width: `${depthPercent}%` }} 
                      />
                      <div className="w-24 font-mono text-red-400 relative z-10 pl-2">{formatPrice(level.price)}</div>
                      <div className="flex-1 text-right text-gray-300 relative z-10 pr-2 font-mono">{formatAmount(level.amount)}</div>
                      <div className={`w-16 text-right relative z-10 pr-2 text-[10px] uppercase ${level.filled ? 'text-red-400' : 'text-gray-500'}`}>
                        {level.filled ? 'Filled' : 'Open'}
                      </div>
                    </div>
                  );
                })}
                {buyLevels.length === 0 && <div className="text-gray-500 text-sm py-2">No buy levels</div>}
              </div>
            </div>
          </div>

          {/* Center Price Indicator */}
          {state?.centerPrice && (
            <div className="mt-4 pt-4 border-t border-gray-700/50 text-center">
              <span className="text-xs text-gray-400 uppercase tracking-wider">Center Price</span>
              <div className="text-white font-mono text-lg">{formatPrice(state.centerPrice)}</div>
            </div>
          )}
        </div>
      )}

      {/* Active Positions */}
      {(showDetails || showPositionsDetail) && (
        <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Active Positions</h3>
            <Button size="xs" onClick={() => setShowPositionsDetail(!showPositionsDetail)}>
              {showPositionsDetail ? 'Collapse' : 'Expand'}
            </Button>
          </div>
          
          {activePositions.length > 0 ? (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {activePositions.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)).map((position) => {
                let pnl = position.pnl;
                if (pnl === undefined && position.entryPrice && currentPrice) {
                  if (position.side === 'buy') {
                    pnl = (currentPrice - position.entryPrice) * (position.filledAmount || position.amount || 0);
                  } else {
                    pnl = (position.entryPrice - currentPrice) * (position.filledAmount || position.amount || 0);
                  }
                }
                
                return (
                  <div key={position.id} className="p-3 bg-gray-800/50 border border-gray-700/50 rounded-lg">
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          position.side === 'buy' 
                            ? 'bg-green-900/50 text-green-400' 
                            : 'bg-red-900/50 text-red-400'
                        }`}>
                          {position.side?.toUpperCase() || 'POSITION'}
                        </span>
                        <span className="text-white font-mono">{(() => {
                          const amt = (typeof position.amount === 'number' && position.amount > 0) ? position.amount : position.filledAmount;
                          return amt !== undefined ? formatAmount(amt) : 'N/A';
                        })()}</span>
                        <span className="text-gray-400">@</span>
                        <span className="text-white font-mono">{(() => {
                          const isStableTo = typeof tokens?.toUsd === 'number' && Math.abs((tokens as any).toUsd - 1) < 0.03;
                          const entryUsdPerTo = (position as any).entryUsdPerTo as number | undefined;
                          const p = position.entryPrice as number | undefined;
                          if (isStableTo) {
                            if (typeof entryUsdPerTo === 'number' && typeof p === 'number' && p > 0) {
                              return formatUsd(entryUsdPerTo / p);
                            }
                            if (typeof (tokens as any).fromUsd === 'number') return formatUsd((tokens as any).fromUsd);
                            if (typeof p === 'number') return formatPrice(p);
                            return 'N/A';
                          }
                          if (typeof entryUsdPerTo === 'number') return formatUsd(entryUsdPerTo);
                          if (typeof p === 'number' && tokens?.fromUsd) return formatPriceUsdFromPair(p);
                          if (typeof p === 'number') return formatPrice(p);
                          return 'N/A';
                        })()}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {pnl !== undefined && (
                          <div className={`font-mono text-sm ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            PnL: {tokens?.fromUsd ? formatUsd(pnl * tokens.fromUsd) : pnl.toFixed(4)}
                          </div>
                        )}
                        <Button size="xs" variant="danger" onClick={() => handleClosePosition(position.id)}>
                          Close
                        </Button>
                        {position.transactionSignature && (
                          <a
                            href={`https://solscan.io/tx/${position.transactionSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 text-xs"
                            title="View on Solscan"
                          >
                            🔗
                          </a>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs text-gray-400 mt-2">
                      <div className="flex items-center gap-4">
                        {(() => {
                          const side = position.plannedExitSide;
                          const price = position.plannedExitPrice;
                          if (!side || !price) {
                            return position.intention ? (
                              <span className="text-gray-300">{position.intention}</span>
                            ) : null;
                          }
                          const label = side === 'sell' ? 'TP Sell' : 'Buy back';
                          const distPct = (typeof currentPrice === 'number' && typeof price === 'number')
                            ? ((price - currentPrice) / currentPrice) * 100
                            : undefined;
                          return (
                            <span className="text-gray-300">
                              {label} @{formatPrice(price)}
                              {typeof distPct === 'number' ? ` (${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%)` : ''}
                            </span>
                          );
                        })()}
                        {position.timeSinceOpen && (
                          <span className="text-yellow-400 font-mono">
                            Open: {formatDuration(position.timeSinceOpen)}
                          </span>
                        )}
                      </div>
                      <div className="text-gray-500">
                        {position.openedAt ? new Date(position.openedAt).toLocaleTimeString() : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState message="No active positions" />
          )}
        </div>
      )}

      {/* Trade History */}
      {(showDetails || showHistoryDetail) && (
        <div className="bg-gray-700/30 border border-gray-600/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Trade Summary</h3>
            <Button size="xs" onClick={() => setShowHistoryDetail(!showHistoryDetail)}>
              {showHistoryDetail ? 'Collapse' : 'Expand'}
            </Button>
          </div>
          
          {tradeHistory.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {(() => {
                const groupedTrades = tradeHistory.reduce((groups, position) => {
                  const key = position.pairedPositionId || position.id;
                  if (!groups[key]) groups[key] = [];
                  groups[key].push(position);
                  return groups;
                }, {} as Record<string, GridPosition[]>);

                const sortedGroups = Object.values(groupedTrades)
                  .sort((a, b) => (b[0].openedAt || 0) - (a[0].openedAt || 0))
                  .slice(0, 20);

                return sortedGroups.map((group, groupIndex) => {
                  const isCompleteCycle = group.length === 2 && 
                    group.some(p => p.side === 'buy') && 
                    group.some(p => p.side === 'sell');
                  
                  const buyTrade = group.find(p => p.side === 'buy');
                  const sellTrade = group.find(p => p.side === 'sell');
                  
                  let totalPnl = 0;
                  if (isCompleteCycle && buyTrade && sellTrade) {
                    const spentFrom = buyTrade.amount || 0;
                    const receivedFrom = sellTrade.filledAmount || 0;
                    totalPnl = receivedFrom - spentFrom;
                  } else {
                    totalPnl = group.reduce((sum, p) => sum + (p.pnl || 0), 0);
                  }

                  if (isCompleteCycle && buyTrade && sellTrade) {
                    const buyFromAmt = buyTrade.amount || 0;
                    const buyToAmt = buyTrade.filledAmount || 0;
                    const sellFromAmt = sellTrade.amount || 0;
                    const sellToAmt = sellTrade.filledAmount || 0;
                    
                    return (
                      <div key={`cycle-${groupIndex}`} className="flex justify-between items-center p-3 bg-gray-800/50 border border-gray-700/50 rounded-lg text-xs">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="px-2 py-1 rounded text-xs font-medium bg-blue-900/50 text-blue-400">
                            CYCLE
                          </span>
                          <span className="text-gray-300">
                            BUY {formatAmount(buyFromAmt)} {tokens?.fromSymbol || 'USDC'}
                          </span>
                          <span className="text-gray-500">→</span>
                          <span className="text-green-400">{formatAmount(buyToAmt)} {tokens?.toSymbol || 'SOL'}</span>
                          <span className="text-gray-500">→</span>
                          <span className="text-gray-300">
                            SELL {formatAmount(sellFromAmt)} {tokens?.toSymbol || 'SOL'}
                          </span>
                          <span className="text-gray-500">→</span>
                          <span className="text-green-400">{formatAmount(sellToAmt)} {tokens?.fromSymbol || 'USDC'}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {(() => {
                            const durationMs = Math.max(buyTrade?.timeSinceOpen || 0, sellTrade?.timeSinceOpen || 0);
                            return durationMs > 0 ? (
                              <span className="text-yellow-400 font-mono" title="Time in position">
                                {formatDuration(durationMs)}
                              </span>
                            ) : null;
                          })()}
                          <div className={`font-mono ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {tokens?.fromUsd ? `${totalPnl >= 0 ? '+' : ''}${formatUsd(Math.abs(totalPnl) * tokens.fromUsd)}` : `${totalPnl >= 0 ? '+' : ''}${formatAmount(Math.abs(totalPnl))} ${tokens?.fromSymbol || 'USDC'}`}
                          </div>
                          <div className="text-gray-500">
                            {sellTrade.closedAt ? new Date(sellTrade.closedAt).toLocaleTimeString() :
                             buyTrade.openedAt ? new Date(buyTrade.openedAt).toLocaleTimeString() : ''}
                          </div>
                        </div>
                      </div>
                    );
                  } else {
                    return group.map((position) => (
                      <div key={position.id} className="flex justify-between items-center p-3 bg-gray-800/50 border border-gray-700/50 rounded-lg text-xs">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            position.side === 'buy' 
                              ? 'bg-green-900/50 text-green-400' 
                              : 'bg-red-900/50 text-red-400'
                          }`}>
                            {position.side?.toUpperCase() || 'TRADE'}
                          </span>
                          <span className="text-white font-mono">{formatAmount(position.amount || 0)}</span>
                          <span className="text-gray-500">@</span>
                          <span className="text-white font-mono">{formatPrice(position.entryPrice)}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {position.pnl !== undefined && (
                            <div className={`font-mono ${position.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {tokens?.fromUsd ? formatUsd(position.pnl * tokens.fromUsd) : position.pnl.toFixed(4)}
                            </div>
                          )}
                          <div className="text-gray-500">
                            {position.closedAt ? new Date(position.closedAt).toLocaleTimeString() :
                             position.openedAt ? new Date(position.openedAt).toLocaleTimeString() : ''}
                          </div>
                        </div>
                      </div>
                    ));
                  }
                });
              })()}
            </div>
          ) : (
            <EmptyState message="No successful trades yet" />
          )}
        </div>
      )}

      {/* Toggle Details Buttons */}
      {!showDetails && (
        <div className="flex items-center gap-2">
          <Button size="xs" onClick={() => setShowLevelsDetail(!showLevelsDetail)}>
            {showLevelsDetail ? 'Hide Levels' : 'Show Levels'}
          </Button>
          <Button size="xs" onClick={() => setShowPositionsDetail(!showPositionsDetail)}>
            {showPositionsDetail ? 'Hide Positions' : 'Show Positions'}
          </Button>
          <Button size="xs" onClick={() => setShowHistoryDetail(!showHistoryDetail)}>
            {showHistoryDetail ? 'Hide History' : 'Show History'}
          </Button>
        </div>
      )}
    </div>
  );
};
