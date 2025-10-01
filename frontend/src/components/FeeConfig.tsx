import React, { useState, useEffect } from 'react';
import { logger } from '../utils/logger';

interface FeeConfigProps {
  onSave: (config: any) => void;
  onCancel: () => void;
  initialConfig?: any;
}

export const FeeConfig: React.FC<FeeConfigProps> = ({ onSave, onCancel, initialConfig }) => {
  const [config, setConfig] = useState({
    // Basic fee settings
    baseFee: initialConfig?.baseFee || 5000,
    priorityFee: initialConfig?.priorityFee || 1000,
    maxFee: initialConfig?.maxFee || 100000,
    dynamicFees: initialConfig?.dynamicFees ?? true,
    feeMultiplier: initialConfig?.feeMultiplier || 1.0,
    minFee: initialConfig?.minFee || 1000,
    maxFeeMultiplier: initialConfig?.maxFeeMultiplier || 10.0,
    feeUpdateInterval: initialConfig?.feeUpdateInterval || 30000, // 30 seconds
    networkCongestionThreshold: initialConfig?.networkCongestionThreshold || 0.8,
    
    // Jupiter-specific settings
    jupiterPriorityFee: initialConfig?.jupiterPriorityFee || 1000, // lamports
    jupiterMaxAccounts: initialConfig?.jupiterMaxAccounts || 64,
    jupiterDynamicCompute: initialConfig?.jupiterDynamicCompute ?? true,
    jupiterLegacyTransaction: initialConfig?.jupiterLegacyTransaction ?? false,
    jupiterSlippageBps: initialConfig?.jupiterSlippageBps || 50, // 0.5% default
    jupiterMaxSlippageBps: initialConfig?.jupiterMaxSlippageBps || 500, // 5% max
  });

  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      await onSave(config);
    } catch (error) {
      logger.error('Failed to save fee configuration:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field: string, value: any) => {
    setConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold text-white mb-6">Fee Configuration</h2>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Fee Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-600 pb-2">Basic Fee Settings</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Base Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.baseFee}
                  onChange={(e) => handleChange('baseFee', parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  step="1000"
                />
                <p className="text-xs text-gray-400 mt-1">Minimum fee for all transactions</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Priority Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.priorityFee}
                  onChange={(e) => handleChange('priorityFee', parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  step="1000"
                />
                <p className="text-xs text-gray-400 mt-1">Additional fee for transaction priority</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.maxFee}
                  onChange={(e) => handleChange('maxFee', parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  step="10000"
                />
                <p className="text-xs text-gray-400 mt-1">Maximum fee per transaction</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Min Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.minFee}
                  onChange={(e) => handleChange('minFee', parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  step="1000"
                />
                <p className="text-xs text-gray-400 mt-1">Minimum fee when using dynamic fees</p>
              </div>
            </div>
          </div>

          {/* Dynamic Fee Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-600 pb-2">Dynamic Fee Settings</h3>
            
            <div className="flex items-center space-x-3">
              <input
                type="checkbox"
                id="dynamicFees"
                checked={config.dynamicFees}
                onChange={(e) => handleChange('dynamicFees', e.target.checked)}
                className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
              />
              <label htmlFor="dynamicFees" className="text-sm font-medium text-gray-300">
                Enable Dynamic Fees
              </label>
            </div>
            <p className="text-xs text-gray-400">Automatically adjust fees based on network conditions</p>

            {config.dynamicFees && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Fee Multiplier
                  </label>
                  <input
                    type="number"
                    value={config.feeMultiplier}
                    onChange={(e) => handleChange('feeMultiplier', parseFloat(e.target.value) || 1.0)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0.1"
                    max="100"
                    step="0.1"
                  />
                  <p className="text-xs text-gray-400 mt-1">Base multiplier for dynamic fee calculation</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Max Fee Multiplier
                  </label>
                  <input
                    type="number"
                    value={config.maxFeeMultiplier}
                    onChange={(e) => handleChange('maxFeeMultiplier', parseFloat(e.target.value) || 10.0)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="1"
                    max="100"
                    step="0.1"
                  />
                  <p className="text-xs text-gray-400 mt-1">Maximum multiplier for dynamic fees</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Fee Update Interval (ms)
                  </label>
                  <input
                    type="number"
                    value={config.feeUpdateInterval}
                    onChange={(e) => handleChange('feeUpdateInterval', parseInt(e.target.value) || 30000)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="5000"
                    max="300000"
                    step="5000"
                  />
                  <p className="text-xs text-gray-400 mt-1">How often to update dynamic fees</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Network Congestion Threshold
                  </label>
                  <input
                    type="number"
                    value={config.networkCongestionThreshold}
                    onChange={(e) => handleChange('networkCongestionThreshold', parseFloat(e.target.value) || 0.8)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0.1"
                    max="1.0"
                    step="0.1"
                  />
                  <p className="text-xs text-gray-400 mt-1">Threshold for increasing fees (0.0-1.0)</p>
                </div>
              </div>
            )}
          </div>

          {/* Jupiter Configuration */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-600 pb-2">Jupiter Swap Configuration</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Jupiter Priority Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.jupiterPriorityFee}
                  onChange={(e) => handleChange('jupiterPriorityFee', parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  step="1000"
                />
                <p className="text-xs text-gray-400 mt-1">Priority fee for Jupiter swaps</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Accounts
                </label>
                <input
                  type="number"
                  value={config.jupiterMaxAccounts}
                  onChange={(e) => handleChange('jupiterMaxAccounts', parseInt(e.target.value) || 64)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="1"
                  max="256"
                  step="1"
                />
                <p className="text-xs text-gray-400 mt-1">Maximum accounts per transaction</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Default Slippage (basis points)
                </label>
                <input
                  type="number"
                  value={config.jupiterSlippageBps}
                  onChange={(e) => handleChange('jupiterSlippageBps', parseInt(e.target.value) || 50)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="1"
                  max="1000"
                  step="1"
                />
                <p className="text-xs text-gray-400 mt-1">Default slippage tolerance (50 = 0.5%)</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Slippage (basis points)
                </label>
                <input
                  type="number"
                  value={config.jupiterMaxSlippageBps}
                  onChange={(e) => handleChange('jupiterMaxSlippageBps', parseInt(e.target.value) || 500)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="1"
                  max="10000"
                  step="1"
                />
                <p className="text-xs text-gray-400 mt-1">Maximum allowed slippage (500 = 5%)</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="jupiterDynamicCompute"
                  checked={config.jupiterDynamicCompute}
                  onChange={(e) => handleChange('jupiterDynamicCompute', e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="jupiterDynamicCompute" className="text-sm font-medium text-gray-300">
                  Dynamic Compute Unit Limit
                </label>
              </div>
              <p className="text-xs text-gray-400">Let Jupiter optimize compute units automatically</p>

              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="jupiterLegacyTransaction"
                  checked={config.jupiterLegacyTransaction}
                  onChange={(e) => handleChange('jupiterLegacyTransaction', e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="jupiterLegacyTransaction" className="text-sm font-medium text-gray-300">
                  Use Legacy Transaction Format
                </label>
              </div>
              <p className="text-xs text-gray-400">Use legacy transactions for better compatibility</p>
            </div>
          </div>

          {/* Fee Preview */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-600 pb-2">Fee Preview</h3>
            <div className="bg-gray-700 rounded-lg p-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-400">Base Fee</div>
                  <div className="text-white font-mono">{config.baseFee.toLocaleString()} lamports</div>
                </div>
                <div>
                  <div className="text-gray-400">Priority Fee</div>
                  <div className="text-white font-mono">{config.priorityFee.toLocaleString()} lamports</div>
                </div>
                <div>
                  <div className="text-gray-400">Jupiter Priority Fee</div>
                  <div className="text-white font-mono">{config.jupiterPriorityFee.toLocaleString()} lamports</div>
                </div>
                <div>
                  <div className="text-gray-400">Total Fee (SOL)</div>
                  <div className="text-white font-mono">{((config.baseFee + config.priorityFee) / 1e9).toFixed(9)} SOL</div>
                </div>
                <div>
                  <div className="text-gray-400">Slippage</div>
                  <div className="text-white font-mono">{(config.jupiterSlippageBps / 100).toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-gray-400">Max Slippage</div>
                  <div className="text-white font-mono">{(config.jupiterMaxSlippageBps / 100).toFixed(2)}%</div>
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-3 pt-4 border-t border-gray-600">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
