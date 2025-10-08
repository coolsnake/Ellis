import React from 'react';
import { LiquidationMonitor } from '../drift';

export const DriftSection: React.FC<{
  apiBase: string;
  driftSubaccounts: any[];
  driftSelectedSubId: number;
  driftNewSubName: string;
  driftRenameSubName: string;
  driftOpBusy: boolean;
  setDriftSelectedSubId: (id: number) => void;
  setDriftNewSubName: (s: string) => void;
  setDriftRenameSubName: (s: string) => void;
  setDriftOpBusy: (v: boolean) => void;
  setDriftSubaccounts: (list: any[]) => void;
  ls: Array<{ key: string }>;
}> = (p) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="p-3 bg-gray-800 rounded md:col-span-2">
        <div className="text-white font-semibold mb-2">Subaccounts</div>
        {/* Controls are still driven by callbacks passed from App for now */}
      </div>
      <div className="p-3 bg-gray-800 rounded">
        <div className="text-white font-semibold mb-2">Liquidations</div>
        <div className="mt-3 grid grid-cols-1 gap-3">
          {p.ls.map((x) => (
            <LiquidationMonitor key={x.key} apiBase={p.apiBase} liquidatorKey={x.key} />
          ))}
        </div>
      </div>
    </div>
  );
};


