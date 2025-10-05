import React, { useState, useEffect, useRef } from 'react';

interface SystemConfigProps {
  onSave: (config: any) => void;
  onCancel: () => void;
  initialConfig: any;
}

export const SystemConfig: React.FC<SystemConfigProps> = ({ onSave, onCancel, initialConfig }) => {
  const initialized = useRef(false);
  const userEdited = useRef(false);
  const [config, setConfig] = useState({
    rpcUrl: '',
    jupiterApiUrl: '',
    targetTickTimeMs: 2000,
    maxRetries: 3,
    retryDelayMs: 1000,
    connectionTimeoutMs: 30000,
    enableLogging: true,
    logLevel: 'info',
    frontendLogLevel: 'info',
    baseFee: 5000,
    priorityFee: 1000,
    maxFee: 100000,
    dynamicFees: false,
    feeMultiplier: 1.0,
    minFee: 1000,
    maxFeeMultiplier: 10.0,
    feeUpdateInterval: 30000,
    networkCongestionThreshold: 0.8,
    jupiterPriorityFee: 1000,
    jupiterMaxAccounts: 64,
    jupiterDynamicCompute: true,
    jupiterLegacyTransaction: false,
    jupiterSlippageBps: 50,
    jupiterMaxSlippageBps: 500,
    wrapAndUnwrapSol: true,
    // Logging categories
    logCategories: [] as string[],
    enabledLogCategories: [] as string[],
    frontendEnabledLogCategories: [] as string[],
    // Structured logging (optional advanced): mirrored from backend CONFIG.system.log
    log: undefined as undefined | {
      level?: 'error'|'warn'|'info'|'debug';
      categories?: Record<string,'error'|'warn'|'info'|'debug'>;
      enableCodes?: string[];
      disableCodes?: string[];
      sample?: Record<string, number>;
      rateLimit?: Record<string, { perSec?: number; minIntervalMs?: number }>;
    },
  });

  useEffect(() => {
    // Initialize from props once to avoid heartbeat updates resetting form edits
    if (!initialized.current && initialConfig) {
      setConfig({
        rpcUrl: initialConfig.rpcUrl || '',
        jupiterApiUrl: initialConfig.system?.jupiterApiUrl || '',
        targetTickTimeMs: initialConfig.system?.targetTickTimeMs || 2000,
        maxRetries: initialConfig.system?.maxRetries || 3,
        retryDelayMs: initialConfig.system?.retryDelayMs || 1000,
        connectionTimeoutMs: initialConfig.system?.connectionTimeoutMs || 30000,
        enableLogging: initialConfig.system?.enableLogging !== false,
        logLevel: initialConfig.system?.logLevel || 'info',
        frontendLogLevel: (initialConfig.system?.frontendLogLevel || initialConfig.system?.logLevel || 'info'),
        wrapAndUnwrapSol: initialConfig.system?.wrapAndUnwrapSol !== false,
        logCategories: Array.isArray(initialConfig.logCategories) ? initialConfig.logCategories : (Array.isArray(initialConfig.system?.logCategories) ? initialConfig.system.logCategories : []),
        enabledLogCategories: Array.isArray(initialConfig.system?.enabledLogCategories) ? initialConfig.system.enabledLogCategories : [],
        frontendEnabledLogCategories: Array.isArray(initialConfig.system?.frontendEnabledLogCategories) ? initialConfig.system.frontendEnabledLogCategories : [],
        baseFee: initialConfig.fees?.baseFee || 5000,
        priorityFee: initialConfig.fees?.priorityFee || 1000,
        maxFee: initialConfig.fees?.maxFee || 100000,
        dynamicFees: initialConfig.fees?.dynamicFees || false,
        feeMultiplier: initialConfig.fees?.feeMultiplier || 1.0,
        minFee: initialConfig.fees?.minFee || 1000,
        maxFeeMultiplier: initialConfig.fees?.maxFeeMultiplier || 10.0,
        feeUpdateInterval: initialConfig.fees?.feeUpdateInterval || 30000,
        networkCongestionThreshold: initialConfig.fees?.networkCongestionThreshold || 0.8,
        jupiterPriorityFee: initialConfig.fees?.jupiterPriorityFee || 1000,
        jupiterMaxAccounts: initialConfig.fees?.jupiterMaxAccounts || 64,
        jupiterDynamicCompute: initialConfig.fees?.jupiterDynamicCompute !== false,
        jupiterLegacyTransaction: initialConfig.fees?.jupiterLegacyTransaction || false,
        jupiterSlippageBps: initialConfig.fees?.jupiterSlippageBps || 50,
        jupiterMaxSlippageBps: initialConfig.fees?.jupiterMaxSlippageBps || 500,
        log: (initialConfig.system?.log || undefined),
      });
      initialized.current = true;
    }
  }, [initialConfig]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    try { window.localStorage.setItem('frontendEnabledLogCategories', JSON.stringify(config.frontendEnabledLogCategories || [])); } catch {}
    onSave({
      rpcUrl: config.rpcUrl,
      system: {
        jupiterApiUrl: config.jupiterApiUrl,
        targetTickTimeMs: config.targetTickTimeMs,
        maxRetries: config.maxRetries,
        retryDelayMs: config.retryDelayMs,
        connectionTimeoutMs: config.connectionTimeoutMs,
        enableLogging: config.enableLogging,
        logLevel: config.logLevel,
        frontendLogLevel: config.frontendLogLevel,
        wrapAndUnwrapSol: config.wrapAndUnwrapSol,
        enabledLogCategories: config.enabledLogCategories,
        frontendEnabledLogCategories: config.frontendEnabledLogCategories,
        log: config.log,
      },
      fees: {
        baseFee: config.baseFee,
        priorityFee: config.priorityFee,
        maxFee: config.maxFee,
        dynamicFees: config.dynamicFees,
        feeMultiplier: config.feeMultiplier,
        minFee: config.minFee,
        maxFeeMultiplier: config.maxFeeMultiplier,
        feeUpdateInterval: config.feeUpdateInterval,
        networkCongestionThreshold: config.networkCongestionThreshold,
        jupiterPriorityFee: config.jupiterPriorityFee,
        jupiterMaxAccounts: config.jupiterMaxAccounts,
        jupiterDynamicCompute: config.jupiterDynamicCompute,
        jupiterLegacyTransaction: config.jupiterLegacyTransaction,
        jupiterSlippageBps: config.jupiterSlippageBps,
        jupiterMaxSlippageBps: config.jupiterMaxSlippageBps,
      }
    });
  };

  const handleChange = (field: string, value: any) => {
    userEdited.current = true;
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold text-white mb-6">System Configuration</h2>
        <form onSubmit={handleSubmit} className="space-y-6">
          
          {/* RPC Configuration */}
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-white mb-4">RPC Configuration</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  RPC URL
                </label>
                <input
                  type="url"
                  value={config.rpcUrl}
                  onChange={(e) => handleChange('rpcUrl', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="https://api.mainnet-beta.solana.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Jupiter API URL
                </label>
                <input
                  type="url"
                  value={config.jupiterApiUrl}
                  onChange={(e) => handleChange('jupiterApiUrl', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="https://quote-api.jup.ag/v6"
                />
              </div>
            </div>
          </div>

          {/* System Settings */}
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-white mb-4">System Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Target Tick Time (ms)
                </label>
                <input
                  type="number"
                  value={config.targetTickTimeMs}
                  onChange={(e) => handleChange('targetTickTimeMs', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="100"
                  max="10000"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Retries
                </label>
                <input
                  type="number"
                  value={config.maxRetries}
                  onChange={(e) => handleChange('maxRetries', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                  max="10"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Retry Delay (ms)
                </label>
                <input
                  type="number"
                  value={config.retryDelayMs}
                  onChange={(e) => handleChange('retryDelayMs', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="100"
                  max="10000"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Connection Timeout (ms)
                </label>
                <input
                  type="number"
                  value={config.connectionTimeoutMs}
                  onChange={(e) => handleChange('connectionTimeoutMs', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="1000"
                  max="120000"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Log Level
                </label>
                <select
                  value={config.logLevel}
                  onChange={(e) => handleChange('logLevel', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Frontend Log Level
                </label>
                <select
                  value={config.frontendLogLevel}
                  onChange={(e) => handleChange('frontendLogLevel', e.target.value)}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
                <p className="text-xs text-gray-400 mt-1">Controls log verbosity in this browser only.</p>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-300 mb-2">Backend Log Categories</label>
                <div className="flex flex-wrap gap-2 bg-gray-600 p-3 rounded-md border border-gray-500">
                  {(config.logCategories || []).map((cat) => {
                    const checked = (config.enabledLogCategories || []).includes(cat);
                    return (
                      <label key={cat} className="inline-flex items-center space-x-2 bg-gray-700 rounded px-2 py-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(config.enabledLogCategories || []);
                            if (e.target.checked) next.add(cat); else next.delete(cat);
                            handleChange('enabledLogCategories', Array.from(next));
                          }}
                        />
                        <span className="text-xs text-gray-200">{cat}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-400 mt-1">Backend will drop unchecked categories at the source.</p>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-300 mb-2">Frontend Log Categories</label>
                <div className="flex flex-wrap gap-2 bg-gray-600 p-3 rounded-md border border-gray-500">
                  {(config.logCategories || []).map((cat) => {
                    const checked = (config.frontendEnabledLogCategories || []).includes(cat);
                    return (
                      <label key={cat} className="inline-flex items-center space-x-2 bg-gray-700 rounded px-2 py-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(config.frontendEnabledLogCategories || []);
                            if (e.target.checked) next.add(cat); else next.delete(cat);
                            handleChange('frontendEnabledLogCategories', Array.from(next));
                          }}
                        />
                        <span className="text-xs text-gray-200">{cat}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-400 mt-1">Browser will hide unchecked categories locally.</p>
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="enableLogging"
                  checked={config.enableLogging}
                  onChange={(e) => handleChange('enableLogging', e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor="enableLogging" className="text-sm font-medium text-gray-300">
                  Enable Logging
                </label>
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="wrapAndUnwrapSol"
                  checked={config.wrapAndUnwrapSol}
                  onChange={(e) => handleChange('wrapAndUnwrapSol', e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor="wrapAndUnwrapSol" className="text-sm font-medium text-gray-300">
                  Wrap/Unwrap SOL automatically (disable for persistent WSOL)
                </label>
              </div>
            </div>
          </div>

          {/* Advanced Logging (Structured) */}
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-white mb-2">Advanced Logging (Structured)</h3>
            <p className="text-xs text-gray-300 mb-3">Configure per-category levels, enable/disable codes, sampling, and rate-limits. Leave empty to use defaults.</p>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Global Level</label>
                <select
                  value={(config.log?.level as any) || ''}
                  onChange={(e) => handleChange('log', { ...(config.log || {}), level: e.target.value as any })}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">(inherit)</option>
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Per-Category Levels (JSON)</label>
                <textarea
                  rows={4}
                  value={JSON.stringify(config.log?.categories || {}, null, 2)}
                  onChange={(e) => {
                    try { const v = JSON.parse(e.target.value || '{}'); handleChange('log', { ...(config.log || {}), categories: v }); } catch {}
                  }}
                  className="w-full px-3 py-2 font-mono text-xs bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Enable Codes (JSON array)</label>
                  <textarea
                    rows={3}
                    value={JSON.stringify(config.log?.enableCodes || [])}
                    onChange={(e) => { try { handleChange('log', { ...(config.log || {}), enableCodes: JSON.parse(e.target.value || '[]') }); } catch {} }}
                    className="w-full px-3 py-2 font-mono text-xs bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Disable Codes (JSON array)</label>
                  <textarea
                    rows={3}
                    value={JSON.stringify(config.log?.disableCodes || [])}
                    onChange={(e) => { try { handleChange('log', { ...(config.log || {}), disableCodes: JSON.parse(e.target.value || '[]') }); } catch {} }}
                    className="w-full px-3 py-2 font-mono text-xs bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Sampling (code-&gt;prob) JSON</label>
                  <textarea
                    rows={3}
                    value={JSON.stringify(config.log?.sample || {}, null, 2)}
                    onChange={(e) => { try { handleChange('log', { ...(config.log || {}), sample: JSON.parse(e.target.value || '{}') }); } catch {} }}
                    className="w-full px-3 py-2 font-mono text-xs bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Rate Limit (code-&gt;spec) JSON</label>
                  <textarea
                    rows={3}
                    value={JSON.stringify(config.log?.rateLimit || {}, null, 2)}
                    onChange={(e) => { try { handleChange('log', { ...(config.log || {}), rateLimit: JSON.parse(e.target.value || '{}') }); } catch {} }}
                    className="w-full px-3 py-2 font-mono text-xs bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Fee Configuration */}
          <div className="bg-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-white mb-4">Fee Configuration</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Base Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.baseFee}
                  onChange={(e) => handleChange('baseFee', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Priority Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.priorityFee}
                  onChange={(e) => handleChange('priorityFee', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.maxFee}
                  onChange={(e) => handleChange('maxFee', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Jupiter Priority Fee (lamports)
                </label>
                <input
                  type="number"
                  value={config.jupiterPriorityFee}
                  onChange={(e) => handleChange('jupiterPriorityFee', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Jupiter Max Accounts
                </label>
                <input
                  type="number"
                  value={config.jupiterMaxAccounts}
                  onChange={(e) => handleChange('jupiterMaxAccounts', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="1"
                  max="128"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Jupiter Slippage (bps)
                </label>
                <input
                  type="number"
                  value={config.jupiterSlippageBps}
                  onChange={(e) => handleChange('jupiterSlippageBps', Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  min="1"
                  max="10000"
                />
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="dynamicFees"
                  checked={config.dynamicFees}
                  onChange={(e) => handleChange('dynamicFees', e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor="dynamicFees" className="text-sm font-medium text-gray-300">
                  Dynamic Fees
                </label>
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="jupiterDynamicCompute"
                  checked={config.jupiterDynamicCompute}
                  onChange={(e) => handleChange('jupiterDynamicCompute', e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor="jupiterDynamicCompute" className="text-sm font-medium text-gray-300">
                  Jupiter Dynamic Compute
                </label>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Save Configuration
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
