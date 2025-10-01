import React, { useState, useEffect } from 'react';
import { logger } from '../utils/logger';

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
  // Planned exit metadata for accurate display
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
}

export const GridMonitor: React.FC<GridMonitorProps> = ({ strategyName, apiBase, currentPrice, showDetails = false }) => {
  const [levels, setLevels] = useState<GridLevel[]>([]);
  const [positions, setPositions] = useState<GridPosition[]>([]);
  const [activePositions, setActivePositions] = useState<GridPosition[]>([]);
  const [tradeHistory, setTradeHistory] = useState<GridPosition[]>([]);
  const [state, setState] = useState<GridState | null>(null);
  const [performance, setPerformance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tokens, setTokens] = useState<{fromToken: string, toToken: string, fromSymbol: string, toSymbol: string, fromUsd?: number | null, toUsd?: number | null} | null>(null);

  const formatAmount = (n: number | undefined | null) => {
    const v = Number(n || 0);
    return v.toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  };

  const formatPrice = (n: number | undefined | null) => {
    const v = Math.abs(Number(n || 0));
    return v.toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
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
    // Compute $ per toToken from pair (to per from): USD/to = USD/from * (to/from)
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

  const handleClosePosition = async (positionId: string) => {
    try {
      const response = await fetch(`${apiBase}/grid/close-position/${strategyName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId })
      });
      
      if (response.ok) {
        // Remove the position from active positions immediately
        setActivePositions(prev => prev.filter(pos => pos.id !== positionId));
        
        // Refresh data to get updated trade history
        await fetchGridData();
        logger.info('Position closed successfully');
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
    }, 1000); // Update every 1 second for more responsive price updates
    
    setLoading(false);
    return () => clearInterval(interval);
  }, [strategyName, apiBase]);

  if (loading) {
    return <div className="text-white">Loading grid data...</div>;
  }

  const buyLevels = levels.filter(l => l.side === 'buy').sort((a, b) => b.price - a.price); // Highest at top, lowest at bottom
  const sellLevels = levels.filter(l => l.side === 'sell').sort((a, b) => b.price - a.price); // Highest at top
  const filledLevels = levels.filter(l => l.filled);
  const minPrice = levels.length ? Math.min(...levels.map(l => l.price)) : undefined;
  const maxPrice = levels.length ? Math.max(...levels.map(l => l.price)) : undefined;
  const buyOnly = levels.filter(l => l.side === 'buy');
  const buyLevelAmount = buyOnly.length ? (buyOnly.reduce((sum, l) => sum + (l.amount || 0), 0) / buyOnly.length) : undefined;

  // Compute average completed cycle duration
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

  return (
    <div className="space-y-6">
      {/* Grid Overview */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">Grid Overview</h3>
          <button
            onClick={rebalanceGrid}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            Rebalance
          </button>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-400">Center Price</div>
            <div className="text-white font-mono">{state?.centerPrice?.toFixed(6) || 'N/A'}</div>
          </div>
          <div>
            <div className="text-gray-400">Current Price</div>
            <div className="text-white font-mono">{currentPrice?.toFixed(6) || 'N/A'}</div>
          </div>
          <div>
            <div className="text-gray-400">Total Levels</div>
            <div className="text-white">{levels.length}</div>
          </div>
          <div>
            <div className="text-gray-400">Filled Levels</div>
            <div className="text-white">{filledLevels.length}</div>
          </div>
        </div>
        
        {/* Strategy Info */}
        <div className="mt-4 p-3 bg-gray-700/50 border border-gray-600/60 rounded">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-400">Pair</div>
              <div className="text-white">{tokens?.fromSymbol || tokens?.fromToken || 'FROM'} → {tokens?.toSymbol || tokens?.toToken || 'TO'}</div>
            </div>
            <div>
              <div className="text-gray-400">Amount / Level</div>
              <div className="text-white font-mono">{buyLevelAmount !== undefined ? formatAmount(buyLevelAmount) : 'N/A'}</div>
            </div>
            <div>
              <div className="text-gray-400">Grid Range</div>
              <div className="text-white font-mono">{minPrice !== undefined && maxPrice !== undefined ? `${formatPrice(minPrice)} → ${formatPrice(maxPrice)}` : 'N/A'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Performance Metrics */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-white mb-4">Performance</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-gray-400">Total PnL</div>
            <div className={`font-mono ${(state?.totalPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {(state?.totalPnl || 0).toFixed(4)}
            </div>
          </div>
          <div>
            <div className="text-gray-400">Completed Cycles</div>
            <div className="text-white font-mono">{state?.completedCycles || 0}</div>
          </div>
          <div>
            <div className="text-gray-400">Total Trades</div>
            <div className="text-white font-mono">{state?.totalTrades || 0}</div>
          </div>
          <div>
            <div className="text-gray-400">Active Positions</div>
            <div className="text-white">{activePositions.length}</div>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-700">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-400">Avg Cycle Time</div>
              <div className="text-white font-mono">{averageCycleDurationMs !== undefined ? formatDuration(averageCycleDurationMs) : 'N/A'}</div>
            </div>
          </div>
        </div>
        </div>

      {showDetails && (
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold text-white mb-4">Grid Levels</h3>
        
        {/* Sell Levels */}
        <div className="mb-4">
          <h4 className="text-sm font-medium text-green-400 mb-2">Sell Levels (Above Center)</h4>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {sellLevels.map((level) => (
              <div
                key={level.id}
                className={`flex justify-between items-center p-2 rounded text-xs ${
                  level.filled 
                    ? 'bg-green-900 text-green-200' 
                    : currentPrice && currentPrice >= level.price
                    ? 'bg-green-800 text-green-100'
                    : 'bg-gray-700 text-gray-300'
                }`}
              >
                <span className="font-mono">{formatPrice(level.price)}</span>
                <span className={level.filled ? 'text-green-300' : 'text-green-200'}>{formatAmount(level.amount)}</span>
                <span className={level.filled ? 'text-green-400' : 'text-gray-400'}>
                  {level.filled ? 'Filled' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Center Price */}
        {state?.centerPrice && (
          <div className="text-center py-2 border-t border-b border-gray-600">
            <div className="text-sm text-gray-400">Center Price</div>
            <div className="text-white font-mono text-lg">{state.centerPrice.toFixed(6)}</div>
          </div>
        )}

        {/* Buy Levels */}
        <div>
          <h4 className="text-sm font-medium text-red-400 mb-2">Buy Levels (Below Center)</h4>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {buyLevels.map((level) => (
              <div
                key={level.id}
                className={`flex justify-between items-center p-2 rounded text-xs ${
                  level.filled 
                    ? 'bg-red-900 text-red-200' 
                    : currentPrice && currentPrice <= level.price
                    ? 'bg-red-800 text-red-100'
                    : 'bg-gray-700 text-gray-300'
                }`}
              >
                <span className="font-mono">{formatPrice(level.price)}</span>
                <span className={level.filled ? 'text-red-300' : 'text-red-200'}>{formatAmount(level.amount)}</span>
                <span className={level.filled ? 'text-red-400' : 'text-gray-400'}>
                  {level.filled ? 'Filled' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}



      {showDetails && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-white mb-4">Active Positions</h3>
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {activePositions.length > 0 ? (
            activePositions
              .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
              .map((position) => {
                // Format time since open as hh:mm:ss
                const formatTimeSinceOpen = (timeMs: number) => {
                  const totalSeconds = Math.floor(timeMs / 1000);
                  const hours = Math.floor(totalSeconds / 3600);
                  const minutes = Math.floor((totalSeconds % 3600) / 60);
                  const seconds = totalSeconds % 60;
                  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                };

                return (
                  <div key={position.id} className="p-3 bg-gray-700 rounded-lg text-sm">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center space-x-3">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          position.side === 'buy' 
                            ? 'bg-green-900 text-green-200' 
                            : 'bg-red-900 text-red-200'
                        }`}>
                          {position.side?.toUpperCase() || 'POSITION'}
                        </span>
                        <span className="text-white font-mono">{(() => {
                          const amt = (typeof position.amount === 'number' && position.amount > 0) ? position.amount : position.filledAmount;
                          return amt !== undefined ? formatAmount(amt) : 'N/A';
                        })()}</span>
                        <span className="text-gray-400">@{(() => {
                          const isStableTo = typeof tokens?.toUsd === 'number' && Math.abs((tokens as any).toUsd - 1) < 0.03;
                          const entryUsdPerTo = (position as any).entryUsdPerTo as number | undefined;
                          const p = position.entryPrice as number | undefined;
                          if (isStableTo) {
                            if (typeof entryUsdPerTo === 'number' && typeof p === 'number' && p > 0) {
                              // Show USD per fromToken when trading into a stablecoin
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
                      <div className="flex items-center space-x-2">
                        {(() => {
                          // Calculate PNL for active positions
                          let pnl = position.pnl;
                          if (pnl === undefined && position.entryPrice && currentPrice) {
                            // Calculate unrealized PNL for active positions
                            if (position.side === 'buy') {
                              // For buy positions: PNL = (currentPrice - entryPrice) * amount
                              pnl = (currentPrice - position.entryPrice) * (position.filledAmount || position.amount || 0);
                            } else {
                              // For sell positions: PNL = (entryPrice - currentPrice) * amount
                              pnl = (position.entryPrice - currentPrice) * (position.filledAmount || position.amount || 0);
                            }
                          }
                          
                          return pnl !== undefined ? (
                            <div className={`font-mono text-sm ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              PnL: {tokens?.fromUsd ? formatUsd(pnl * tokens.fromUsd) : pnl.toFixed(4)}
                            </div>
                          ) : null;
                        })()}
                        <button
                          onClick={() => handleClosePosition(position.id)}
                          className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors"
                          title="Close Position"
                        >
                          Close
                        </button>
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
                    
                    <div className="flex justify-between items-center text-xs text-gray-400">
                <div className="flex items-center space-x-4">
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
                              {label} @{(() => {
                                // Show the intended grid level price directly to avoid confusing USD conversions
                                return formatPrice(price);
                              })()}
                              {typeof distPct === 'number' ? ` (${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%)` : ''}
                            </span>
                          );
                        })()}
                        {position.timeSinceOpen && (
                          <span className="text-yellow-400 font-mono">
                            Open: {formatTimeSinceOpen(position.timeSinceOpen)}
                  </span>
                        )}
                </div>
                      <div className="text-gray-500">
                        {position.openedAt ? new Date(position.openedAt).toLocaleTimeString() : ''}
                </div>
              </div>
          </div>
                );
              })
          ) : (
            <div className="text-gray-400 text-center py-4">No active positions</div>
          )}
        </div>
      </div>
      )}

      {showDetails && (
        <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold text-white mb-4">Trade Summary</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
          {tradeHistory.length > 0 ? (
            (() => {
              // Group trades by cycles (buy/sell pairs)
              const groupedTrades = tradeHistory.reduce((groups, position) => {
                const key = position.pairedPositionId || position.id;
                if (!groups[key]) {
                  groups[key] = [];
                }
                groups[key].push(position);
                return groups;
              }, {} as Record<string, GridPosition[]>);

              // Convert to array and sort by most recent
              const sortedGroups = Object.values(groupedTrades)
                .sort((a, b) => (b[0].openedAt || 0) - (a[0].openedAt || 0))
                .slice(0, 20);

              return sortedGroups.map((group, groupIndex) => {
                const isCompleteCycle = group.length === 2 && 
                  group.some(p => p.side === 'buy') && 
                  group.some(p => p.side === 'sell');
                
                const buyTrade = group.find(p => p.side === 'buy');
                const sellTrade = group.find(p => p.side === 'sell');
                
                // Calculate proper PNL for complete cycles in from-token units (receivedFrom - spentFrom)
                let totalPnl = 0;
                if (isCompleteCycle && buyTrade && sellTrade) {
                  // For buy: spentFrom = buy.amount (from token)
                  // For sell: receivedFrom = sell.filledAmount (from token)
                  const spentFrom = buyTrade.amount || 0;
                  const receivedFrom = sellTrade.filledAmount || 0;
                  totalPnl = receivedFrom - spentFrom;
                  
                  logger.debug('Cycle PNL calculation', {
                    spentFrom,
                    receivedFrom,
                    totalPnl,
                    buyTradeId: buyTrade.id,
                    sellTradeId: sellTrade.id
                  });
                } else {
                  // For individual trades, use the existing PNL
                  totalPnl = group.reduce((sum, p) => sum + (p.pnl || 0), 0);
                }

                if (isCompleteCycle && buyTrade && sellTrade) {
                  // Show linked trades as one line with new format
                  const buyFromAmt = buyTrade.amount || 0; // spent fromToken
                  const buyToAmt = buyTrade.filledAmount || 0; // received toToken
                  const sellFromAmt = sellTrade.amount || 0; // sold toToken
                  const sellToAmt = sellTrade.filledAmount || 0; // received fromToken
                  const buyPrice = buyTrade.entryPrice || 0;
                  const sellPrice = (sellTrade.exitPrice ?? sellTrade.entryPrice ?? 0);
                  
                  return (
                    <div key={`cycle-${groupIndex}`} className="flex justify-between items-center p-2 bg-gray-700 rounded text-xs">
                      <div className="flex items-center space-x-2">
                        <span className="px-2 py-1 rounded text-xs font-medium bg-blue-900 text-blue-200">
                          CYCLE
                        </span>
                        <span className="text-white">BUY {formatAmount(buyFromAmt)} {tokens?.fromSymbol || 'USDC'} @{(() => {
                          const u = (buyTrade as any).entryUsdPerTo as number | undefined;
                          const isStableTo = typeof tokens?.toUsd === 'number' && Math.abs((tokens as any).toUsd - 1) < 0.03;
                          if (isStableTo) {
                            if (typeof u === 'number' && typeof buyPrice === 'number' && buyPrice > 0) return formatUsd(u / buyPrice);
                            if (typeof (tokens as any).fromUsd === 'number') return formatUsd((tokens as any).fromUsd);
                            return formatPrice(buyPrice);
                          }
                          if (typeof u === 'number') return formatUsd(u);
                          if (tokens?.fromUsd) return formatPriceUsdFromPair(buyPrice);
                          return formatPrice(buyPrice);
                        })()}</span>
                        <span className="text-gray-400">→</span>
                        <span className="text-green-400">{formatAmount(buyToAmt)} {tokens?.toSymbol || 'SOL'}</span>
                        <span className="text-gray-400">→</span>
                        <span className="text-white">SELL {formatAmount(sellFromAmt)} {tokens?.toSymbol || 'SOL'} @{(() => {
                          const u = ((sellTrade as any).exitUsdPerTo as number | undefined) ?? ((sellTrade as any).entryUsdPerTo as number | undefined);
                          const isStableTo = typeof tokens?.toUsd === 'number' && Math.abs((tokens as any).toUsd - 1) < 0.03;
                          if (isStableTo) {
                            if (typeof u === 'number' && typeof sellPrice === 'number' && sellPrice > 0) return formatUsd(u / sellPrice);
                            if (typeof (tokens as any).fromUsd === 'number') return formatUsd((tokens as any).fromUsd);
                            return formatPrice(sellPrice);
                          }
                          if (typeof u === 'number') return formatUsd(u);
                          if (tokens?.fromUsd) return formatPriceUsdFromPair(sellPrice);
                          return formatPrice(sellPrice);
                        })()}</span>
                        <span className="text-gray-400">→</span>
                        <span className="text-green-400">{formatAmount(sellToAmt)} {tokens?.fromSymbol || 'USDC'}</span>
                      </div>
                      <div className="flex items-center space-x-2">
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
                        {buyTrade.transactionSignature && (
                          <a
                            href={`https://solscan.io/tx/${buyTrade.transactionSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 text-xs"
                            title="View Buy on Solscan"
                          >
                            🔗B
                          </a>
                        )}
                        {sellTrade.transactionSignature && (
                          <a
                            href={`https://solscan.io/tx/${sellTrade.transactionSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 text-xs"
                            title="View Sell on Solscan"
                          >
                            🔗S
                          </a>
                        )}
                        <div className="text-gray-400 text-xs">
                          {sellTrade.closedAt ? new Date(sellTrade.closedAt).toLocaleTimeString() :
                           buyTrade.openedAt ? new Date(buyTrade.openedAt).toLocaleTimeString() : ''}
                        </div>
                      </div>
                    </div>
                  );
                } else {
                  // Show individual trades with new format using distinct from/to amounts
                  return group.map((position) => {
                    // For buy: fromAmt = amount spent (fromToken), toAmt = filledAmount (toToken received)
                    // For sell: fromAmt = amount sold (toToken), toAmt = filledAmount (fromToken received)
                    const fromAmt = position.amount || 0;
                    const toAmt = position.filledAmount || 0;
                    const price = position.entryPrice || 0;
                    const exitPrice = (position.exitPrice ?? position.entryPrice ?? 0);
                    
                    return (
                      <div key={position.id} className="flex justify-between items-center p-2 bg-gray-700 rounded text-xs">
                        <div className="flex items-center space-x-2">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            position.side === 'buy' 
                              ? 'bg-green-900 text-green-200' 
                              : 'bg-red-900 text-red-200'
                          }`}>
                            {position.side?.toUpperCase() || 'TRADE'}
                  </span>
                          {position.side === 'buy' ? (
                            <>
                              <span className="text-white">{formatAmount(fromAmt)} {tokens?.fromSymbol || 'USDC'} @{(() => {
                                const u = (position as any).entryUsdPerTo as number | undefined;
                                const isStableTo = typeof tokens?.toUsd === 'number' && Math.abs((tokens as any).toUsd - 1) < 0.03;
                                if (isStableTo) {
                                  if (typeof u === 'number' && typeof price === 'number' && price > 0) return formatUsd(u / price);
                                  if (typeof (tokens as any).fromUsd === 'number') return formatUsd((tokens as any).fromUsd);
                                  return formatPrice(price);
                                }
                                if (typeof u === 'number') return formatUsd(u);
                                if (tokens?.fromUsd) return formatPriceUsdFromPair(price);
                                return formatPrice(price);
                              })()}</span>
                              <span className="text-gray-400">→</span>
                              <span className="text-green-400">{formatAmount(toAmt)} {tokens?.toSymbol || 'SOL'}</span>
                            </>
                          ) : (
                            <>
                              <span className="text-white">{formatAmount(fromAmt)} {tokens?.toSymbol || 'SOL'} @{(() => {
                                const u = ((position as any).exitUsdPerTo as number | undefined) ?? ((position as any).entryUsdPerTo as number | undefined);
                                const isStableTo = typeof tokens?.toUsd === 'number' && Math.abs((tokens as any).toUsd - 1) < 0.03;
                                if (isStableTo) {
                                  if (typeof u === 'number' && typeof exitPrice === 'number' && exitPrice > 0) return formatUsd(u / exitPrice);
                                  if (typeof (tokens as any).fromUsd === 'number') return formatUsd((tokens as any).fromUsd);
                                  return formatPrice(exitPrice);
                                }
                                if (typeof u === 'number') return formatUsd(u);
                                if (tokens?.fromUsd) return formatPriceUsdFromPair(exitPrice);
                                return formatPrice(exitPrice);
                              })()}</span>
                              <span className="text-gray-400">→</span>
                              <span className="text-green-400">{formatAmount(toAmt)} {tokens?.fromSymbol || 'USDC'}</span>
                            </>
                          )}
                </div>
                <div className="flex items-center space-x-2">
                        {position.pnl !== undefined && (
                          <div className={`font-mono ${position.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {tokens?.fromUsd ? formatUsd(position.pnl * tokens.fromUsd) : position.pnl.toFixed(4)}
                          </div>
                        )}
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
                        <div className="text-gray-400 text-xs">
                          {position.closedAt ? new Date(position.closedAt).toLocaleTimeString() :
                           position.openedAt ? new Date(position.openedAt).toLocaleTimeString() : ''}
                </div>
              </div>
          </div>
                    );
                  });
                }
              });
            })()
          ) : (
            <div className="text-gray-400 text-center py-4">No successful trades yet</div>
          )}
        </div>
      </div>
      )}
    </div>
  );
};
