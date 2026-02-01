import React from 'react';
import { useSystem } from '../../app/contexts/system';
import { FeeConfig } from '../../components/FeeConfig';
import { SystemConfig } from '../../components/SystemConfig';
import { DataFetchConfig } from '../../components/DataFetchConfig';
import { ArbEngineConfig } from '../../components/ArbEngineConfig';
import { OpportunityConfig } from '../../components/OpportunityConfig';
import { GraphConfig } from '../../components/GraphConfig';
import { LiquidatorRunnerConfig } from '../../components/LiquidatorRunnerConfig';
import { TriggerRunnerConfig } from '../../components/TriggerRunnerConfig';
import { FillerRunnerConfig } from '../../components/FillerRunnerConfig';
import { NotificationConfig } from '../../components/NotificationConfig';

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
  showOpportunityConfig?: boolean;
  onCloseOpportunity?: () => void;
  showLiqRunnerConfig: boolean;
  onCloseLiqRunner: () => void;
  showTriggerRunnerConfig?: boolean;
  onCloseTriggerRunner?: () => void;
  showFillerRunnerConfig: boolean;
  onCloseFillerRunner: () => void;
  showNotificationConfig?: boolean;
  onCloseNotification?: () => void;
}> = (p) => {
  const { system } = useSystem();
  return (
    <>
      {p.showGraphConfig && (<GraphConfig apiBase={p.apiBase} onClose={p.onCloseGraph} />)}
      {p.showFeeConfig && (
        <FeeConfig onSave={p.onSaveFee} onCancel={p.onCloseFee} initialConfig={system?.fees} />
      )}
      {p.showSystemConfig && (
        <SystemConfig onSave={p.onSaveSystem} onCancel={p.onCloseSystem} initialConfig={system as any} />
      )}
      {p.showDataFetchConfig && (<DataFetchConfig apiBase={p.apiBase} onClose={p.onCloseDataFetch} />)}
      {p.showEngineConfig && (<ArbEngineConfig apiBase={p.apiBase} onClose={p.onCloseEngine} />)}
      {p.showOpportunityConfig && (<OpportunityConfig apiBase={p.apiBase} onClose={p.onCloseOpportunity!} />)}
      {p.showLiqRunnerConfig && (<LiquidatorRunnerConfig apiBase={p.apiBase} onClose={p.onCloseLiqRunner} />)}
      {p.showTriggerRunnerConfig && (<TriggerRunnerConfig apiBase={p.apiBase} onClose={p.onCloseTriggerRunner!} />)}
      {p.showFillerRunnerConfig && (<FillerRunnerConfig apiBase={p.apiBase} onClose={p.onCloseFillerRunner} />)}
      {p.showNotificationConfig && (<NotificationConfig onClose={p.onCloseNotification!} />)}
    </>
  );
};


