import React from 'react';
import { GridMonitor } from '../../components/GridMonitor';
import { GridStrategyConfig } from '../../components/GridStrategyConfig';
import { LeveragedGridConfig } from '../../components/LeveragedGridConfig';
import { ThresholdStrategyConfig } from '../../components/ThresholdStrategyConfig';

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
    <section className="bg-gray-900 rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-semibold">Strategies</h2>
        <div className="space-x-2">
          <button className="px-3 py-1 border rounded" onClick={() => p.onCloseGridConfig()}>New Grid</button>
          <button className="px-3 py-1 border rounded" onClick={() => p.onCloseThresholdConfig()}>New Threshold</button>
        </div>
      </div>
      <div className="space-y-2">
        {p.strategies.map((s) => {
          const name = s?.name || 'default';
          const isGrid = isGridStrategy(s);
          return (
            <div key={name} className="p-3 bg-gray-800 rounded">
              <div className="flex items-center justify-between">
                <div className="font-semibold">{name}</div>
                <div className="space-x-2">
                  <button className="px-2 py-1 border rounded" onClick={() => p.onToggleCollapse(name)}>{p.collapsedStrategies[name] ? 'Expand' : 'Collapse'}</button>
                  <button className="px-2 py-1 border rounded" onClick={() => p.onToggleParams(name)}>{p.collapsedStrategyParams[name] ? 'Show Params' : 'Hide Params'}</button>
                  <button className="px-2 py-1 border rounded" onClick={() => p.onRemove(s)}>Remove</button>
                </div>
              </div>
              {isGrid && p.selectedGridStrategies.has(name) ? (
                <div className="mt-4 border-t border-gray-600 pt-4">
                  <GridMonitor strategyName={name} apiBase={p.apiBase} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {p.showGridConfig && (
        <GridStrategyConfig onSave={p.onSaveGrid} onCancel={p.onCloseGridConfig} />
      )}
      {p.showThresholdConfig && (
        <ThresholdStrategyConfig onSave={p.onSaveThreshold} onCancel={p.onCloseThresholdConfig} />
      )}
    </section>
  );
};
