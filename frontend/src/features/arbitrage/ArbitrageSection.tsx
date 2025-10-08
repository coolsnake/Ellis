import React from 'react';
import { ArbitragePanel } from './index';
import { ArbitrageMetrics } from './index';
import { GraphView } from '../graph';

export const ArbitrageSection: React.FC<{ apiBase: string; showGraph: boolean; onToggleGraph: () => void; paused?: boolean }> = ({ apiBase, showGraph, onToggleGraph, paused }) => {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ArbitragePanel apiBase={apiBase} showGraph={showGraph} onToggleGraph={onToggleGraph} />
        <ArbitrageMetrics apiBase={apiBase} paused={paused} />
      </div>
      {showGraph ? (
        <div className="mt-4">
          <GraphView apiBase={apiBase} square />
        </div>
      ) : null}
    </>
  );
};


