import React, { useState, useEffect } from 'react';
import { apiGet, apiPost } from '../utils/api';

interface RouterConfig {
  programId: string | null;
  deployedAt: string | null;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  executionMode: 'direct' | 'flash_loan' | 'auto' | 'sdk_quote';
  vaultOwner: string | null;
  flashLoanFeeBps: number;
  enabled: boolean;
}

interface FeeResponse {
  success: boolean;
  amount: string;
  fee: string;
  repayAmount: string;
  feeBps: number;
}

type RouterConfigProps = {
  apiBase: string;
  onClose: () => void;
  onOpenRouterPanel: () => void;
  onOpenVaultManager: () => void;
};

export const RouterConfig: React.FC<RouterConfigProps> = ({
  apiBase,
  onClose,
  onOpenRouterPanel,
  onOpenVaultManager,
}) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [flashLoanAvailable, setFlashLoanAvailable] = useState(false);
  
  // Fee calculator
  const [feeAmount, setFeeAmount] = useState('');
  const [calculatedFee, setCalculatedFee] = useState<FeeResponse | null>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const data = await apiGet<{
        success: boolean;
        config: RouterConfig;
        ready: boolean;
        flashLoanAvailable: boolean;
      }>('/router/status');
      
      if (data.success) {
        setConfig(data.config);
        setReady(data.ready);
        setFlashLoanAvailable(data.flashLoanAvailable);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleModeChange = async (mode: 'direct' | 'flash_loan' | 'auto' | 'sdk_quote') => {
    if (!config) return;
    setSaving(true);
    setError(null);
    
    try {
      await apiPost('/router/config/mode', { mode });
      setConfig({ ...config, executionMode: mode });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    
    try {
      await apiPost('/router/config/enabled', { enabled: !config.enabled });
      setConfig({ ...config, enabled: !config.enabled });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleVaultOwnerChange = async (vaultOwner: string) => {
    if (!config) return;
    setSaving(true);
    setError(null);
    
    try {
      await apiPost('/router/config', { vaultOwner: vaultOwner || null });
      setConfig({ ...config, vaultOwner: vaultOwner || null });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const calculateFee = async () => {
    if (!feeAmount) return;
    try {
      const data = await apiGet<FeeResponse>(`/router/vaults/any/fee?amount=${feeAmount}`);
      if (data.success) {
        setCalculatedFee(data);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-800 rounded-lg p-6 w-full max-w-xl">
          <div className="text-white text-center">Loading router config...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Router Configuration</h2>
          <button className="text-gray-300 hover:text-white text-xl" onClick={onClose}>✕</button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-600 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Status Overview */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white">Status</h3>
            <div className="flex gap-2">
              <button
                onClick={onOpenRouterPanel}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm"
              >
                Program Panel
              </button>
              <button
                onClick={onOpenVaultManager}
                className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-sm"
              >
                Manage Vaults
              </button>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${ready ? 'bg-green-500' : 'bg-yellow-500'}`} />
              <span className="text-gray-300">Router: {ready ? 'Ready' : 'Not Ready'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${flashLoanAvailable ? 'bg-green-500' : 'bg-gray-500'}`} />
              <span className="text-gray-300">Flash Loan: {flashLoanAvailable ? 'Available' : 'Unavailable'}</span>
            </div>
            <div>
              <span className="text-gray-400">Cluster:</span>
              <span className="text-white ml-2">{config?.cluster || '-'}</span>
            </div>
            <div>
              <span className="text-gray-400">Program:</span>
              <span className="text-white ml-2 font-mono text-xs">
                {config?.programId ? `${config.programId.slice(0, 8)}...` : 'Not deployed'}
              </span>
            </div>
          </div>
        </div>

        {/* Enable/Disable */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">Router Enabled</h3>
              <p className="text-gray-400 text-sm">Enable routing arbitrage through the on-chain program</p>
            </div>
            <button
              onClick={handleToggleEnabled}
              disabled={saving || !config?.programId}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                config?.enabled ? 'bg-green-600' : 'bg-gray-600'
              } ${!config?.programId ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config?.enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Execution Mode */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-3">Execution Mode</h3>
          <div className="space-y-2">
            {([
              { value: 'direct', label: 'Direct', desc: 'Execute swaps with your own tokens' },
              { value: 'flash_loan', label: 'Flash Loan', desc: 'Borrow from vault, execute arb, repay with profit' },
              { value: 'auto', label: 'Auto', desc: 'Use flash loan if vault has funds, otherwise direct' },
              { value: 'sdk_quote', label: 'SDK Quote', desc: 'Use DEX SDK quotes for accurate tick/bin arrays (slower but more reliable)' },
            ] as const).map((option) => (
              <label
                key={option.value}
                className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  config?.executionMode === option.value
                    ? 'bg-blue-600/30 border border-blue-500'
                    : 'bg-gray-600/30 border border-transparent hover:border-gray-500'
                }`}
              >
                <input
                  type="radio"
                  name="executionMode"
                  value={option.value}
                  checked={config?.executionMode === option.value}
                  onChange={() => handleModeChange(option.value)}
                  disabled={saving}
                  className="mt-1"
                />
                <div>
                  <div className="text-white font-medium">{option.label}</div>
                  <div className="text-gray-400 text-sm">{option.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Vault Owner (for flash loans) */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-2">Flash Loan Vault Owner</h3>
          <p className="text-gray-400 text-sm mb-3">
            The wallet that owns the vault to borrow from. Leave empty to use your own wallet.
          </p>
          <input
            type="text"
            value={config?.vaultOwner || ''}
            onChange={(e) => {
              if (config) setConfig({ ...config, vaultOwner: e.target.value || null });
            }}
            onBlur={(e) => handleVaultOwnerChange(e.target.value)}
            placeholder="Leave empty for your wallet"
            className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded focus:border-blue-500 focus:outline-none font-mono text-sm"
          />
        </div>

        {/* Fee Calculator */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-2">Flash Loan Fee Calculator</h3>
          <p className="text-gray-400 text-sm mb-3">
            Flash loan fee: {config?.flashLoanFeeBps || 9} bps (0.{(config?.flashLoanFeeBps || 9).toString().padStart(2, '0')}%)
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              value={feeAmount}
              onChange={(e) => setFeeAmount(e.target.value)}
              placeholder="Amount in base units"
              className="flex-1 px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={calculateFee}
              disabled={!feeAmount}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded"
            >
              Calculate
            </button>
          </div>
          {calculatedFee && (
            <div className="mt-3 text-sm">
              <div className="text-gray-400">
                Borrow: <span className="text-white">{calculatedFee.amount}</span>
              </div>
              <div className="text-gray-400">
                Fee: <span className="text-yellow-400">{calculatedFee.fee}</span>
              </div>
              <div className="text-gray-400">
                Repay: <span className="text-green-400">{calculatedFee.repayAmount}</span>
              </div>
            </div>
          )}
        </div>

        {/* Router Testing - Link to Program Panel */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <h3 className="text-lg font-semibold text-white mb-2">🧪 Router Testing</h3>
          <p className="text-gray-400 text-sm mb-4">
            Test DEX swaps and multi-hop execution through the on-chain router program.
          </p>
          <button
            onClick={() => {
              onClose();
              onOpenRouterPanel();
            }}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm flex items-center gap-2"
          >
            <span>🔬</span>
            Open Router Testing Panel
          </button>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-700">
          <button
            onClick={fetchConfig}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};


