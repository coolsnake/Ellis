import React from 'react';
import { ArbitragePanel } from './index';
import { ArbitrageMetrics } from './index';
import { GraphView } from '../graph';

export const ArbitrageSection: React.FC<{ 
  apiBase: string; 
  showGraph: boolean; 
  onToggleGraph: () => void; 
  paused?: boolean;
  onOpenAltModal?: () => void;
}> = ({ apiBase, showGraph, onToggleGraph, paused, onOpenAltModal }) => {
  return (
    <>
      {/* Full-width layout: ArbitragePanel takes 2/3, ArbitrageMetrics takes 1/3 on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ArbitragePanel apiBase={apiBase} showGraph={showGraph} onToggleGraph={onToggleGraph} />
        </div>
        <div className="lg:col-span-1">
          <ArbitrageMetrics apiBase={apiBase} paused={paused} onOpenAltModal={onOpenAltModal} />
        </div>
      </div>
      {showGraph ? (
        <div className="mt-4">
          <GraphView apiBase={apiBase} square />
        </div>
      ) : null}
    </>
  );
};


