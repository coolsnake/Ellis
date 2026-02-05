import React, { useState } from 'react';
import { GridMonitor } from '../../components/GridMonitor';
import { GridStrategyConfig } from '../../components/GridStrategyConfig';
import { LeveragedGridConfig } from '../../components/LeveragedGridConfig';
import { ThresholdStrategyConfig } from '../../components/ThresholdStrategyConfig';
import { Panel, Button, StatusBadge } from '../../components/ui';

export const StrategiesSection: React.FC<{
  apiBase: string;
  strategies: any[];
  selectedGridStrategies: Set<string>;
  collapsedStrategies: Record<string, boolean>;
  collapsedStrategyParams: Record<string, boolean>;
  onToggleMonitor: (name: string) => void;
  onToggleCollapse: (name: string) => void;
  onToggleParams: (name: string) => void;
  onSaveGrid: (cfg: any) => void;
  onSaveThreshold: (cfg: any) => void;
  onRemove: (s: any) => void;
  showGridConfig: boolean;
  showThresholdConfig: boolean;
  onCloseGridConfig: () => void;
  onCloseThresholdConfig: () => void;
  editingStrategy: any;
}> = (p) => {
  const isGridStrategy = (strategy: any) => !!(strategy.gridType || strategy.gridSpacing || strategy.gridLevels || strategy.totalAmount || strategy.levelAmount);
  
  return (
    <Panel
      title="Strategies"
      actions={
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => p.onCloseGridConfig()}>+ New Grid</Button>
          <Button onClick={() => p.onCloseThresholdConfig()}>+ New Threshold</Button>
        </div>
      }
    >
      {p.strategies.length > 0 ? (
        <div className="space-y-3">
          {p.strategies.map((s) => {
            const name = s?.name || 'default';
            const isGrid = isGridStrategy(s);
            const isCollapsed = p.collapsedStrategies[name];
            const isActive = s?.enabled !== false;
            
            return (
              <div key={name} className="border border-gray-700 rounded-lg overflow-hidden">
                {/* Strategy Header */}
                <div
                  className="bg-gray-800 px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-750 transition-colors"
                  onClick={() => p.onToggleCollapse(name)}
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={isActive ? 'active' : 'inactive'} label="" dotOnly />
                    <span className="font-semibold text-white">{name}</span>
                    <span className={`px-2 py-0.5 rounded text-xs ${isGrid ? 'bg-blue-900/50 text-blue-400' : 'bg-purple-900/50 text-purple-400'}`}>
                      {isGrid ? 'Grid' : 'Threshold'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={(e) => { e?.stopPropagation(); p.onToggleParams(name); }}
                      title="Toggle Parameters"
                    >
                      {p.collapsedStrategyParams[name] ? 'Show Params' : 'Hide Params'}
                    </Button>
                    <Button
                      size="xs"
                      variant="danger"
                      onClick={(e) => { e?.stopPropagation(); p.onRemove(s); }}
                      title="Remove Strategy"
                    >
                      Remove
                    </Button>
                    <svg
                      className={`w-5 h-5 text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-180'}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                
                {/* Strategy Body */}
                {!isCollapsed && (
                  <div className="bg-gray-900 border-t border-gray-700">
                    {/* Strategy Parameters */}
                    {!p.collapsedStrategyParams[name] && (
                      <div className="p-4 border-b border-gray-700/50">
                        <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Parameters</h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                          {isGrid ? (
                            <>
                              <div className="bg-gray-800/50 rounded p-2">
                                <div className="text-xs text-gray-500">Grid Type</div>
                                <div className="text-white font-mono">{s.gridType || 'arithmetic'}</div>
                              </div>
                              <div className="bg-gray-800/50 rounded p-2">
                                <div className="text-xs text-gray-500">Grid Levels</div>
                                <div className="text-white font-mono">{s.gridLevels || '-'}</div>
                              </div>
                              <div className="bg-gray-800/50 rounded p-2">
                                <div className="text-xs text-gray-500">Grid Spacing</div>
                                <div className="text-white font-mono">{s.gridSpacing ? `${(s.gridSpacing * 100).toFixed(2)}%` : '-'}</div>
                              </div>
                              <div className="bg-gray-800/50 rounded p-2">
                                <div className="text-xs text-gray-500">Level Amount</div>
                                <div className="text-white font-mono">{s.levelAmount || s.totalAmount || '-'}</div>
                              </div>
                              {s.fromToken && (
                                <div className="bg-gray-800/50 rounded p-2">
                                  <div className="text-xs text-gray-500">From Token</div>
                                  <div className="text-white font-mono text-xs truncate" title={s.fromToken}>{s.fromToken}</div>
                                </div>
                              )}
                              {s.toToken && (
                                <div className="bg-gray-800/50 rounded p-2">
                                  <div className="text-xs text-gray-500">To Token</div>
                                  <div className="text-white font-mono text-xs truncate" title={s.toToken}>{s.toToken}</div>
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="bg-gray-800/50 rounded p-2">
                                <div className="text-xs text-gray-500">Threshold</div>
                                <div className="text-white font-mono">{s.threshold ? `${(s.threshold * 100).toFixed(2)}%` : '-'}</div>
                              </div>
                              <div className="bg-gray-800/50 rounded p-2">
                                <div className="text-xs text-gray-500">Amount</div>
                                <div className="text-white font-mono">{s.amount || '-'}</div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {/* Grid Monitor */}
                    {isGrid && p.selectedGridStrategies.has(name) && (
                      <div className="p-4">
                        <GridMonitor strategyName={name} apiBase={p.apiBase} />
                      </div>
                    )}
                    
                    {/* Toggle Monitor Button for Grid Strategies */}
                    {isGrid && (
                      <div className="p-4 pt-0">
                        <Button
                          size="xs"
                          onClick={() => p.onToggleMonitor(name)}
                        >
                          {p.selectedGridStrategies.has(name) ? 'Hide Monitor' : 'Show Monitor'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-lg mb-2">No strategies configured</div>
          <div className="text-sm">Create a new Grid or Threshold strategy to get started</div>
        </div>
      )}
      
      {/* Config Modals */}
      {p.showGridConfig && (
        <GridStrategyConfig onSave={p.onSaveGrid} onCancel={p.onCloseGridConfig} />
      )}
      {p.showThresholdConfig && (
        <ThresholdStrategyConfig onSave={p.onSaveThreshold} onCancel={p.onCloseThresholdConfig} />
      )}
    </Panel>
  );
};
