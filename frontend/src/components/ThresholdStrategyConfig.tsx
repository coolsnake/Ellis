import React, { useState } from 'react';

interface ThresholdStrategyConfigProps {
  onSave: (config: any) => void;
  onCancel: () => void;
  initialConfig?: any;
}

export const ThresholdStrategyConfig: React.FC<ThresholdStrategyConfigProps> = ({ onSave, onCancel, initialConfig }) => {
  const [config, setConfig] = useState({
    name: initialConfig?.name || '',
    fromToken: initialConfig?.fromToken || 'USDC',
    toToken: initialConfig?.toToken || 'SOL',
    active: initialConfig?.active ?? true,
    testMode: initialConfig?.testMode ?? false,
    
    // Basic trading parameters
    buyPct: initialConfig?.buyPct || 0.05,
    sellPct: initialConfig?.sellPct || 0.05,
    amount: initialConfig?.amount || 0.1,
    
    // Advanced parameters
    marketEnter: initialConfig?.marketEnter || null,
    fixedAnchor: initialConfig?.fixedAnchor ?? false,
    anchorPairAtSetup: initialConfig?.anchorPairAtSetup || 0,
    scaleAggressiveness: initialConfig?.scaleAggressiveness || 0.5,
    scaleStepPct: initialConfig?.scaleStepPct || 0.01,
    slippageBps: initialConfig?.slippageBps || 100,
    maxOpenPositions: initialConfig?.maxOpenPositions || 3,
    maxPositionSize: initialConfig?.maxPositionSize || 1.0,
    
    // LST parameters
    lst: initialConfig?.lst ?? false,
    navSource: initialConfig?.navSource || 'protocol',
    hysteresisBps: initialConfig?.hysteresisBps || 50,
    cooldownMs: initialConfig?.cooldownMs || 1000,
    
    // Trading parameters
    feeBps: initialConfig?.feeBps || 30,
    extraSlippageBps: initialConfig?.extraSlippageBps || 50,
    minEdgeBps: initialConfig?.minEdgeBps || 60,
    
    // Sliding anchor
    slidingAnchor: initialConfig?.slidingAnchor ?? false,
    slideRateBpsPerSec: initialConfig?.slideRateBpsPerSec || 1,
    slideMaxPct: initialConfig?.slideMaxPct || 0.01,
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
        <h2 className="text-2xl font-bold text-white mb-6">Threshold Strategy Configuration</h2>
        
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
            </div>
          </div>

          {/* Trading Parameters */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Trading Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Buy Threshold (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.buyPct}
                  onChange={(e) => handleChange('buyPct', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Sell Threshold (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.sellPct}
                  onChange={(e) => handleChange('sellPct', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Amount</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.amount}
                  onChange={(e) => handleChange('amount', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Market Enter</label>
                <select
                  value={config.marketEnter || ''}
                  onChange={(e) => handleChange('marketEnter', e.target.value || null)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                >
                  <option value="">None</option>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </div>
            </div>
          </div>

          {/* Scaling Parameters */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Scaling (Pyramiding)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Scale Aggressiveness</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={config.scaleAggressiveness}
                  onChange={(e) => handleChange('scaleAggressiveness', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Scale Step (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.scaleStepPct}
                  onChange={(e) => handleChange('scaleStepPct', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
            </div>
          </div>

          {/* Risk Management */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Risk Management</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Open Positions</label>
                <input
                  type="number"
                  min="1"
                  value={config.maxOpenPositions}
                  onChange={(e) => handleChange('maxOpenPositions', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Position Size</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.maxPositionSize}
                  onChange={(e) => handleChange('maxPositionSize', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
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
            </div>
          </div>

          {/* LST Parameters */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">LST (Liquid Staking Token) Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.lst}
                  onChange={(e) => handleChange('lst', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Enable LST Trading</span>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">NAV Source</label>
                <select
                  value={config.navSource}
                  onChange={(e) => handleChange('navSource', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                >
                  <option value="protocol">Protocol</option>
                  <option value="ema">EMA</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Hysteresis (bps)</label>
                <input
                  type="number"
                  min="0"
                  value={config.hysteresisBps}
                  onChange={(e) => handleChange('hysteresisBps', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Anchor at Setup</label>
                <input
                  type="number"
                  step="0.000001"
                  value={config.anchorPairAtSetup}
                  onChange={(e) => handleChange('anchorPairAtSetup', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
            </div>
          </div>

          {/* Sliding Anchor */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Sliding Anchor</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.slidingAnchor}
                  onChange={(e) => handleChange('slidingAnchor', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Enable Sliding Anchor</span>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Slide Rate (bps/sec)</label>
                <input
                  type="number"
                  min="0"
                  value={config.slideRateBpsPerSec}
                  onChange={(e) => handleChange('slideRateBpsPerSec', parseInt(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Slide (%)</label>
                <input
                  type="number"
                  step="0.001"
                  value={config.slideMaxPct}
                  onChange={(e) => handleChange('slideMaxPct', parseFloat(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                />
              </div>
            </div>
          </div>

          {/* Advanced Parameters */}
          <div className="border-t border-gray-600 pt-6">
            <h3 className="text-lg font-semibold text-white mb-4">Advanced Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={config.fixedAnchor}
                  onChange={(e) => handleChange('fixedAnchor', e.target.checked)}
                  className="mr-2"
                />
                <span className="text-gray-300">Fixed Anchor</span>
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
