import React from 'react';
import { FeeConfig } from '../../components/FeeConfig';
import { SystemConfig } from '../../components/SystemConfig';
import { DataFetchConfig } from '../../components/DataFetchConfig';
import { ArbEngineConfig } from '../../components/ArbEngineConfig';
import { GraphConfig } from '../../components/GraphConfig';
import { LiquidatorRunnerConfig } from '../../components/LiquidatorRunnerConfig';

export const ConfigsSection: React.FC<{
  apiBase: string;
  showGraphConfig: boolean;
  onCloseGraph: () => void;
  showFeeConfig: boolean;
  onSaveFee: (cfg: any) => Promise<void>;
  onCloseFee: () => void;
  showSystemConfig: boolean;
  onSaveSystem: (cfg: any) => Promise<void>;
  onCloseSystem: () => void;
  showDataFetchConfig: boolean;
  onCloseDataFetch: () => void;
  showEngineConfig: boolean;
  onCloseEngine: () => void;
  showLiqRunnerConfig: boolean;
  onCloseLiqRunner: () => void;
}> = (p) => {
  return (
    <>
      {p.showGraphConfig && (<GraphConfig apiBase={p.apiBase} onClose={p.onCloseGraph} />)}
      {p.showFeeConfig && (
        <FeeConfig onSave={p.onSaveFee} onCancel={p.onCloseFee} />
      )}
      {p.showSystemConfig && (
        <SystemConfig onSave={p.onSaveSystem} onCancel={p.onCloseSystem} initialConfig={{} as any} />
      )}
      {p.showDataFetchConfig && (<DataFetchConfig apiBase={p.apiBase} onClose={p.onCloseDataFetch} />)}
      {p.showEngineConfig && (<ArbEngineConfig apiBase={p.apiBase} onClose={p.onCloseEngine} />)}
      {p.showLiqRunnerConfig && (<LiquidatorRunnerConfig apiBase={p.apiBase} onClose={p.onCloseLiqRunner} />)}
    </>
  );
};


