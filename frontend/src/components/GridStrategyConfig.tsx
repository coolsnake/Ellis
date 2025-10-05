import React, { useState } from 'react';

interface GridStrategyConfigProps {
  onSave: (config: any) => void;
  onCancel: () => void;
  initialConfig?: any;
}

export const GridStrategyConfig: React.FC<GridStrategyConfigProps> = ({ onSave, onCancel, initialConfig }) => {
  const [config, setConfig] = useState({
    name: initialConfig?.name || '',
    fromToken: initialConfig?.fromToken || 'USDC',
    toToken: initialConfig?.toToken || 'SOL',
    active: initialConfig?.active ?? true,
    testMode: initialConfig?.testMode ?? false,
    
    // Grid parameters
    gridType: initialConfig?.gridType || 'arithmetic',
    gridSpacing: initialConfig?.gridSpacing || 0.01,
    gridLevels: initialConfig?.gridLevels || 5,
    centerPrice: initialConfig?.centerPrice || 0,
    totalAmount: initialConfig?.totalAmount || 1.0,
    levelAmount: initialConfig?.levelAmount || 0.1,
    
    // Bias
    bias: initialConfig?.bias || 'neutral',
    biasStrength: initialConfig?.biasStrength ?? 0,
    
    // Initial range settings
    initialBuyRange: initialConfig?.initialBuyRange || 0.05, // 5% below center for initial buy levels
    initialSellRange: initialConfig?.initialSellRange || 0.05, // 5% above center for initial sell levels
    
    // Risk management
    maxPositions: initialConfig?.maxPositions || 10,
    stopLoss: initialConfig?.stopLoss || 0,
    takeProfit: initialConfig?.takeProfit || 0,
    rebalanceThreshold: initialConfig?.rebalanceThreshold || 0.05,
    
    // Advanced features
    adaptiveSpacing: initialConfig?.adaptiveSpacing ?? false,
    volatilityPeriod: initialConfig?.volatilityPeriod || 20,
    minLevelSpacing: initialConfig?.minLevelSpacing || 0.005,
    maxLevelSpacing: initialConfig?.maxLevelSpacing || 0.02,
    
    // Sliding center price
    slidingCenter: initialConfig?.slidingCenter ?? false,
    slideRate: initialConfig?.slideRate || 10, // 10 basis points per second
    slideMaxDistance: initialConfig?.slideMaxDistance || 5, // 5% maximum distance
    
    // Trading parameters
    slippageBps: initialConfig?.slippageBps || 100,
    cooldownMs: initialConfig?.cooldownMs || 1000,
    feeBps: initialConfig?.feeBps || 30,
    extraSlippageBps: initialConfig?.extraSlippageBps || 50,
    minEdgeBps: initialConfig?.minEdgeBps || 60,
    // Controls
    onlyClose: initialConfig?.onlyClose ?? false,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(config);
  };

  const handleChange = (field: string, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold text-white mb-6">Grid Strategy Configuration</h2>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Configuration */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Strategy Name</label>
              <input
                type="text"
                value={config.name}
                onChange={(e) => handleChange('name', e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                required
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">From Token</label>
              <input
                type="text"
                value={config.fromToken}
                onChange={(e) => handleChange('fromToken', e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                required
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">To Token</label>
              <input
                type="text"
                value={config.toToken}
                onChange={(e) => handleChange('toToken', e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                required
              />
            </div>
            
            <div className="flex items-center space-x-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.active}
                  onChange={(e) => handleChange('active', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Active</span>
              </label>
              
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.testMode}
                  onChange={(e) => handleChange('testMode', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Test Mode</span>
              </label>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={config.onlyClose}
                onChange={(e) => handleChange('onlyClose', e.target.checked)}
                className="mr-2"
              />
              <span className="text-gray-300">Only Close (no new buys)</span>
            </label>
            </div>
          </div>

          {/* Grid Configuration */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Grid Configuration</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Grid Type</label>
                <select
                  value={config.gridType}
                  onChange={(e) => handleChange('gridType', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                >
                  <option value="arithmetic">Arithmetic</option>
                  <option value="geometric">Geometric</option>
                  <option value="fibonacci">Fibonacci</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Grid Spacing (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.gridSpacing}
                  onChange={(e) => handleChange('gridSpacing', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Bias</label>
              <select
                value={config.bias}
                onChange={(e) => handleChange('bias', e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
              >
                <option value="neutral">Neutral</option>
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Bias Strength (0-1)</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={config.biasStrength}
                onChange={(e) => handleChange('biasStrength', Math.max(0, Math.min(1, parseFloat(e.target.value))))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
              />
            </div>

            <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Grid Levels</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={config.gridLevels}
                  onChange={(e) => handleChange('gridLevels', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Center Price (0 = auto)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={config.centerPrice}
                  onChange={(e) => handleChange('centerPrice', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Total Amount</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.totalAmount}
                  onChange={(e) => handleChange('totalAmount', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Level Amount</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.levelAmount}
                  onChange={(e) => handleChange('levelAmount', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Initial Buy Range (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.initialBuyRange}
                  onChange={(e) => handleChange('initialBuyRange', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Initial Sell Range (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.initialSellRange}
                  onChange={(e) => handleChange('initialSellRange', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
            </div>
          </div>

          {/* Risk Management */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Risk Management</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Positions</label>
                <input
                  type="number"
                  min="1"
                  value={config.maxPositions}
                  onChange={(e) => handleChange('maxPositions', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Stop Loss (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={config.stopLoss}
                  onChange={(e) => handleChange('stopLoss', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Take Profit (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={config.takeProfit}
                  onChange={(e) => handleChange('takeProfit', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Rebalance Threshold (%)</label>
                <input
                  type="number"
                  step="0.01"
                  value={config.rebalanceThreshold}
                  onChange={(e) => handleChange('rebalanceThreshold', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
            </div>
          </div>

          {/* Advanced Features */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Advanced Features</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.adaptiveSpacing}
                  onChange={(e) => handleChange('adaptiveSpacing', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Adaptive Spacing</span>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Volatility Period</label>
                <input
                  type="number"
                  min="5"
                  max="100"
                  value={config.volatilityPeriod}
                  onChange={(e) => handleChange('volatilityPeriod', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Min Level Spacing (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.minLevelSpacing}
                  onChange={(e) => handleChange('minLevelSpacing', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Level Spacing (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.maxLevelSpacing}
                  onChange={(e) => handleChange('maxLevelSpacing', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
            </div>
          </div>

          {/* Sliding Center Price */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Sliding Center Price</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.slidingCenter}
                  onChange={(e) => handleChange('slidingCenter', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Enable Sliding Center</span>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Slide Rate (bps/sec)</label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={config.slideRate}
                  onChange={(e) => handleChange('slideRate', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  disabled={!config.slidingCenter}
                />
                <p className="text-xs text-gray-400 mt-1">Rate at which center price slides towards current price</p>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Slide Distance (%)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="50"
                  value={config.slideMaxDistance}
                  onChange={(e) => handleChange('slideMaxDistance', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  disabled={!config.slidingCenter}
                />
                <p className="text-xs text-gray-400 mt-1">Maximum distance center can slide from original position</p>
              </div>
            </div>
          </div>

          {/* Trading Parameters */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Trading Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Slippage (bps)</label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={config.slippageBps}
                  onChange={(e) => handleChange('slippageBps', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Cooldown (ms)</label>
                <input
                  type="number"
                  min="0"
                  value={config.cooldownMs}
                  onChange={(e) => handleChange('cooldownMs', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Fee (bps)</label>
                <input
                  type="number"
                  min="0"
                  value={config.feeBps}
                  onChange={(e) => handleChange('feeBps', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Extra Slippage (bps)</label>
                <input
                  type="number"
                  min="0"
                  value={config.extraSlippageBps}
                  onChange={(e) => handleChange('extraSlippageBps', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Min Edge (bps)</label>
                <input
                  type="number"
                  min="0"
                  value={config.minEdgeBps}
                  onChange={(e) => handleChange('minEdgeBps', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-4 pt-6">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Save Strategy
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
