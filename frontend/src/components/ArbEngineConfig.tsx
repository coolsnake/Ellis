import React, { useEffect, useState } from 'react';
import { ROUTES } from '../utils/routes';
import type { ExecEngineConfigPublic } from 'shared/config-types';
import { useModalConfig } from '../app/hooks/useModalConfig';

type Props = { apiBase: string; onClose: () => void };

export const ArbEngineConfig: React.FC<Props> = ({ apiBase, onClose }) => {
  // Persist UI preferences AND form values to localStorage
  const [uiPrefs, updateUiPrefs] = useModalConfig('arbEngineConfig', {
    expandedSections: {
      execution: true,
      sizing: true,
      multiHop: false,
      nearMiss: true,
      edgeAllow: true,
    },
    // Save last used configuration values
    lastValues: null as any,
  });
  
  const [cfg, setCfg] = useState<any>(uiPrefs.lastValues || {
    mode: 'simulate',
    slippageBpsDefault: 50,
    computeUnitLimit: 1000000,
    computeUnitPriceMicroLamports: 500000,
    createAtasInTx: true,
    dynamicCompute: true,
    maxTxSizeBytes: 1200,
    cooldownMs: 5000,
    // Dynamic CU and Priority Fees
    dynamicCuLimits: false,
    dynamicCuBuffer: 1.15,
    dynamicPriorityFees: false,
    priorityFeeUrgency: 'medium' as 'low' | 'medium' | 'high' | 'critical',
    // Skip simulation settings
    skipSimulationMinProfitBps: 25,
    // Adaptive sizing / upward retry
    upwardRetryEnabled: false,
    upwardFactor: 1.5,
    // Size randomness
    sizeRandomnessFactor: 0.1,
    near_miss_enable: true,
    debug_top_n: 5,
    edge_allow: {
      raydium: { amm: true, clmm: true, cpmm: true },
      orca: { amm: true, clmm: true },
      meteora: { clmm: true },
      meteoraBalanced: { v1: true, v2: true },
      pumpswap: { amm: true },
    },
    // Trade Sizing Configuration
    sizingEnabled: true,
    minSizeUsd: 0.1,
    maxSizeUsd: 500,
    aggressiveness: 0.70,
    maxSlippageBps: 500,
    // Multi-hop optimization
    multiHopEnabled: false,
    multiHopMethod: 'ternary_search' as 'ternary_search' | 'binary_search',
    multiHopFixedCostUsd: 0.001,
    multiHopSafetyMargin: 0.80,
    multiHopFallbackToBottleneck: true,
    multiHopDisableCalibration: true, // Disable learned calibration when multi-hop enabled
    // Slippage model params
    ammReserveMultiplier: 0.95,
    clmmLiquidityDecay: 0.70,
    dlmmActiveBinFraction: 0.10,
  });
  
  // Save configuration values to localStorage when they change
  useEffect(() => {
    updateUiPrefs({ lastValues: cfg });
  }, [cfg]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Load execution config (backend)
        const ex = await fetch(`${apiBase}${ROUTES.exec.config}`).then(r => r.ok ? r.json() : null).catch(() => null);
        // Load detector config (arb-rs)
        const det = await fetch(`${apiBase}${ROUTES.arb.config}`).then(r => r.ok ? r.json() : null).catch(() => null);
        // Load executor config (for cooldownMs)
        const execCfg = await fetch(`${apiBase}${ROUTES.arb.executorConfig}`).then(r => r.ok ? r.json() : null).catch(() => null);
        setCfg((p: any) => ({
          ...p,
          ...(ex || {}),
          cooldownMs: execCfg?.cooldownMs ?? p.cooldownMs,
          // Dynamic CU and Priority Fees
          dynamicCuLimits: ex?.dynamicCuLimits ?? p.dynamicCuLimits,
          dynamicCuBuffer: ex?.dynamicCuBuffer ?? p.dynamicCuBuffer,
          dynamicPriorityFees: ex?.dynamicPriorityFees ?? p.dynamicPriorityFees,
          priorityFeeUrgency: ex?.priorityFeeUrgency ?? p.priorityFeeUrgency,
          // Skip simulation settings
          skipSimulationMinProfitBps: execCfg?.skipSimulation?.minProfitBps ?? p.skipSimulationMinProfitBps,
          // Adaptive sizing / upward retry
          upwardRetryEnabled: execCfg?.adaptiveSizing?.upwardRetryEnabled ?? p.upwardRetryEnabled,
          upwardFactor: execCfg?.adaptiveSizing?.upwardFactor ?? p.upwardFactor,
          // Size randomness
          sizeRandomnessFactor: execCfg?.sizeRandomnessFactor ?? p.sizeRandomnessFactor,
          // Trade Sizing Configuration
          sizingEnabled: execCfg?.sizingConfig?.enabled ?? p.sizingEnabled,
          minSizeUsd: execCfg?.sizingConfig?.minSizeUsd ?? p.minSizeUsd,
          maxSizeUsd: execCfg?.sizingConfig?.maxSizeUsd ?? p.maxSizeUsd,
          aggressiveness: execCfg?.sizingConfig?.aggressiveness ?? p.aggressiveness,
          maxSlippageBps: execCfg?.sizingConfig?.maxSlippageBps ?? p.maxSlippageBps,
          // Multi-hop optimization
          multiHopEnabled: execCfg?.sizingConfig?.multiHopOptimization?.enabled ?? p.multiHopEnabled,
          multiHopMethod: execCfg?.sizingConfig?.multiHopOptimization?.method ?? p.multiHopMethod,
          multiHopFixedCostUsd: execCfg?.sizingConfig?.multiHopOptimization?.fixedCostUsd ?? p.multiHopFixedCostUsd,
          multiHopSafetyMargin: execCfg?.sizingConfig?.multiHopOptimization?.safetyMargin ?? p.multiHopSafetyMargin,
          multiHopFallbackToBottleneck: execCfg?.sizingConfig?.multiHopOptimization?.fallbackToBottleneck ?? p.multiHopFallbackToBottleneck,
          multiHopDisableCalibration: execCfg?.sizingConfig?.multiHopOptimization?.disableCalibration ?? p.multiHopDisableCalibration,
          // Slippage model params
          ammReserveMultiplier: execCfg?.sizingConfig?.multiHopOptimization?.slippageParams?.amm?.reserveMultiplier ?? p.ammReserveMultiplier,
          clmmLiquidityDecay: execCfg?.sizingConfig?.multiHopOptimization?.slippageParams?.clmm?.liquidityDecayPerTick ?? p.clmmLiquidityDecay,
          dlmmActiveBinFraction: execCfg?.sizingConfig?.multiHopOptimization?.slippageParams?.dlmm?.activeBinFraction ?? p.dlmmActiveBinFraction,
          near_miss_enable: (det?.near_miss_enable ?? p.near_miss_enable),
          debug_top_n: (det?.debug_top_n ?? p.debug_top_n),
          edge_allow: {
            raydium: {
              amm: det?.edge_allow?.raydium?.amm !== false,
              clmm: det?.edge_allow?.raydium?.clmm !== false,
              cpmm: det?.edge_allow?.raydium?.cpmm !== false,
            },
            orca: {
              amm: det?.edge_allow?.orca?.amm !== false,
              clmm: det?.edge_allow?.orca?.clmm !== false,
            },
            meteora: {
              clmm: det?.edge_allow?.meteora?.clmm !== false,
            },
            meteoraBalanced: {
              // Support both old format (amm) and new format (v1/v2) for backward compatibility
              // If old 'amm' field exists, use it for both v1 and v2
              // Otherwise, use the new v1/v2 fields (defaulting to true if undefined)
              v1: det?.edge_allow?.meteoraBalanced?.amm !== undefined 
                ? det?.edge_allow?.meteoraBalanced?.amm !== false
                : det?.edge_allow?.meteoraBalanced?.v1 !== false,
              v2: det?.edge_allow?.meteoraBalanced?.amm !== undefined 
                ? det?.edge_allow?.meteoraBalanced?.amm !== false
                : det?.edge_allow?.meteoraBalanced?.v2 !== false,
            },
            pumpswap: {
              amm: det?.edge_allow?.pumpswap?.amm !== false,
            },
          },
        }));
      } catch {}
    })();
  }, [apiBase]);

  const set = (k: string, v: any) => setCfg((p: any) => ({ ...p, [k]: v }));
  const setSource = (k: 'jupiter'|'raydium'|'orca', v: boolean) => setCfg((p: any) => ({ ...p, sources: { ...p.sources, [k]: v } }));

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
    const execBody: ExecEngineConfigPublic = {
      mode: cfg.mode === 'direct' ? 'direct' : cfg.mode === 'simulate_then_execute' ? 'simulate_then_execute' : 'simulate',
      slippageBpsDefault: Number(cfg.slippageBpsDefault) || 0,
      computeUnitLimit: Number(cfg.computeUnitLimit) || 0,
      computeUnitPriceMicroLamports: Number(cfg.computeUnitPriceMicroLamports) || 0,
      createAtasInTx: !!cfg.createAtasInTx,
      dynamicCompute: !!cfg.dynamicCompute,
      maxTxSizeBytes: Number(cfg.maxTxSizeBytes || 0) || undefined,
      // Dynamic CU and Priority Fees
      dynamicCuLimits: !!cfg.dynamicCuLimits,
      dynamicCuBuffer: Number(cfg.dynamicCuBuffer) || 1.15,
      dynamicPriorityFees: !!cfg.dynamicPriorityFees,
      priorityFeeUrgency: cfg.priorityFeeUrgency || 'medium',
    };
    const executorBody = {
      cooldownMs: Math.max(0, Number(cfg.cooldownMs) || 5000),
      // Skip simulation settings
      skipSimulation: {
        minProfitBps: Number(cfg.skipSimulationMinProfitBps) || undefined,
      },
      // Adaptive sizing / upward retry
      adaptiveSizing: {
        upwardRetryEnabled: !!cfg.upwardRetryEnabled,
        upwardFactor: Math.max(1.0, Number(cfg.upwardFactor) || 1.5),
      },
      // Size randomness
      sizeRandomnessFactor: Math.max(0, Math.min(0.5, Number(cfg.sizeRandomnessFactor) || 0.1)),
      // Trade Sizing Configuration
      sizingConfig: {
        enabled: !!cfg.sizingEnabled,
        minSizeUsd: Math.max(0.01, Number(cfg.minSizeUsd) || 0.1),
        maxSizeUsd: Math.max(1, Number(cfg.maxSizeUsd) || 500),
        respectWalletBalance: true,
        aggressiveness: Math.max(0.1, Math.min(0.99, Number(cfg.aggressiveness) || 0.70)),
        maxSlippageBps: Math.max(10, Math.min(2000, Number(cfg.maxSlippageBps) || 500)),
        poolTypeAdjustments: { amm: 1.0, clmm: 1.0, dlmm: 1.0 },
        multiHopOptimization: {
          enabled: !!cfg.multiHopEnabled,
          method: cfg.multiHopMethod || 'ternary_search',
          fixedCostUsd: Math.max(0, Number(cfg.multiHopFixedCostUsd) || 0.001),
          safetyMargin: Math.max(0.5, Math.min(1.0, Number(cfg.multiHopSafetyMargin) || 0.80)),
          searchPrecisionUsd: 0.10,
          maxIterations: 20,
          fallbackToBottleneck: cfg.multiHopFallbackToBottleneck !== false,
          disableCalibration: cfg.multiHopDisableCalibration !== false,
          slippageParams: {
            amm: { reserveMultiplier: Math.max(0.5, Math.min(1.0, Number(cfg.ammReserveMultiplier) || 0.95)) },
            clmm: { liquidityDecayPerTick: Math.max(0.3, Math.min(0.99, Number(cfg.clmmLiquidityDecay) || 0.70)), maxTickSimulation: 50 },
            dlmm: { activeBinFraction: Math.max(0.01, Math.min(0.5, Number(cfg.dlmmActiveBinFraction) || 0.10)), liquidityDecayPerBin: 0.75 },
          },
        },
      },
    };
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(`${apiBase}${ROUTES.exec.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(execBody) }),
        fetch(`${apiBase}${ROUTES.arb.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ near_miss_enable: !!cfg.near_miss_enable, debug_top_n: Number(cfg.debug_top_n || 0), edge_allow: cfg.edge_allow }) }),
        fetch(`${apiBase}${ROUTES.arb.executorConfig}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(executorBody) }),
      ]);
      if (!r1.ok || !r2.ok || !r3.ok) throw new Error('Failed to save');
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const addListItem = (k: 'dex_allow', v: string) => {
    if (!v) return; setCfg((p: any) => ({ ...p, [k]: (Array.isArray(p[k]) ? p[k] : []).includes(v) ? p[k] : [...(p[k]||[]), v] }));
  };
  const removeListItem = (k: 'dex_allow', i: number) => setCfg((p: any) => ({ ...p, [k]: (p[k]||[]).filter((_: any, idx: number) => idx !== i) }));

  const toggleSection = (section: 'execution' | 'sizing' | 'multiHop' | 'nearMiss' | 'edgeAllow') => {
    updateUiPrefs({
      expandedSections: {
        ...uiPrefs.expandedSections,
        [section]: !uiPrefs.expandedSections[section],
      },
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Arbitrage Engine</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {error ? <div className="text-red-400 text-sm mb-2">{error}</div> : null}

        <div className="space-y-6">
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Direct Execution</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block text-sm mb-1">Mode</label><select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.mode} onChange={(e)=>set('mode', e.target.value)}><option value="simulate">simulate</option><option value="direct">direct</option><option value="simulate_then_execute">simulate → execute</option></select></div>
              <div><label className="block text-sm mb-1">Default Slippage (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.slippageBpsDefault} onChange={(e)=>set('slippageBpsDefault', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Compute Unit Limit</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.computeUnitLimit} onChange={(e)=>set('computeUnitLimit', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Priority Fee (microLamports)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.computeUnitPriceMicroLamports} onChange={(e)=>set('computeUnitPriceMicroLamports', Number(e.target.value)||0)} /></div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.createAtasInTx} onChange={(e)=>set('createAtasInTx', e.target.checked)} />Create ATAs in transaction</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.dynamicCompute} onChange={(e)=>set('dynamicCompute', e.target.checked)} />Dynamic Compute</label>
              <div><label className="block text-sm mb-1">Max Tx Size (bytes)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.maxTxSizeBytes ?? ''} onChange={(e)=>set('maxTxSizeBytes', Number(e.target.value)||0)} /></div>
            </div>
            
            {/* Dynamic Fees Optimization Section */}
            <div className="border-t border-gray-600 pt-4 mt-4">
              <h4 className="text-sm font-semibold mb-3 text-gray-300">Dynamic Fee Optimization</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="flex items-center gap-2 mb-2">
                    <input type="checkbox" checked={!!cfg.dynamicCuLimits} onChange={(e)=>set('dynamicCuLimits', e.target.checked)} />
                    <span className="text-sm">Dynamic CU Limits</span>
                  </label>
                  <div className="text-xs text-gray-400 ml-6 mb-2">Use simulation result instead of fixed limit</div>
                  {cfg.dynamicCuLimits && (
                    <div className="ml-6">
                      <label className="block text-xs mb-1">CU Buffer Multiplier</label>
                      <input type="number" step="0.05" min="1.0" max="2.0"
                        className="w-24 bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                        value={cfg.dynamicCuBuffer ?? 1.15} 
                        onChange={(e) => set('dynamicCuBuffer', Number(e.target.value) || 1.15)} />
                      <div className="text-xs text-gray-400 mt-1">1.15 = 15% safety margin</div>
                    </div>
                  )}
                </div>
                <div>
                  <label className="flex items-center gap-2 mb-2">
                    <input type="checkbox" checked={!!cfg.dynamicPriorityFees} onChange={(e)=>set('dynamicPriorityFees', e.target.checked)} />
                    <span className="text-sm">Dynamic Priority Fees</span>
                  </label>
                  <div className="text-xs text-gray-400 ml-6 mb-2">Use network-based fees (overrides Priority Fee above)</div>
                  {cfg.dynamicPriorityFees && (
                    <div className="ml-6">
                      <label className="block text-xs mb-1">Urgency Level</label>
                      <select className="w-32 bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                        value={cfg.priorityFeeUrgency ?? 'medium'}
                        onChange={(e) => set('priorityFeeUrgency', e.target.value)}>
                        <option value="low">Low (p25)</option>
                        <option value="medium">Medium (p50)</option>
                        <option value="high">High (p75)</option>
                        <option value="critical">Critical (p95)</option>
                      </select>
                      <div className="text-xs text-gray-400 mt-1">Higher = faster but more expensive</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              <div><label className="block text-sm mb-1">Route Cooldown (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.cooldownMs ?? 5000} onChange={(e)=>set('cooldownMs', Number(e.target.value)||0)} /><div className="text-xs text-gray-400 mt-1">Prevents executing the same route (pool IDs) within this time</div></div>
              <div><label className="block text-sm mb-1">Skip Sim Min Profit (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.skipSimulationMinProfitBps ?? 25} onChange={(e)=>set('skipSimulationMinProfitBps', Number(e.target.value)||0)} /><div className="text-xs text-gray-400 mt-1">Lower threshold for skip simulation on validated pools</div></div>
              <div><label className="block text-sm mb-1">Size Randomness</label><input type="number" step="0.05" min="0" max="0.5" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sizeRandomnessFactor ?? 0.1} onChange={(e)=>set('sizeRandomnessFactor', Number(e.target.value)||0)} /><div className="text-xs text-gray-400 mt-1">Variance factor (0.1 = ±10%)</div></div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.upwardRetryEnabled} onChange={(e)=>set('upwardRetryEnabled', e.target.checked)} />Enable Upward Retry</label>
              <div><label className="block text-sm mb-1">Upward Size Factor</label><input type="number" step="0.1" min="1.0" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.upwardFactor ?? 1.5} onChange={(e)=>set('upwardFactor', Number(e.target.value)||1.5)} disabled={!cfg.upwardRetryEnabled} /><div className="text-xs text-gray-400 mt-1">Test larger sizes to recalibrate (1.5 = +50%)</div></div>
              <label className="flex items-center gap-2 md:col-span-3"><input type="checkbox" checked={!!cfg.near_miss_enable} onChange={(e)=>set('near_miss_enable', e.target.checked)} />Enable near-miss output (arb-rs)</label>
              <div><label className="block text-sm mb-1">Debug Top-N Near Misses</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.debug_top_n} onChange={(e)=>set('debug_top_n', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          {/* Trade Sizing Section */}
          <div className="bg-gray-700 rounded p-4">
            <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => toggleSection('sizing')}>
              <h3 className="text-lg font-semibold">Trade Sizing</h3>
              <span className="text-gray-400">{uiPrefs.expandedSections?.sizing ? '▼' : '▶'}</span>
            </div>
            {uiPrefs.expandedSections?.sizing && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <label className="flex items-center gap-2 md:col-span-3">
                    <input type="checkbox" checked={!!cfg.sizingEnabled} onChange={(e)=>set('sizingEnabled', e.target.checked)} />
                    Enable Dynamic Sizing
                  </label>
                  <div>
                    <label className="block text-sm mb-1">Min Size (USD)</label>
                    <input type="number" step="0.1" min="0.01" max="100"
                      className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                      value={cfg.minSizeUsd ?? 0.1}
                      onChange={(e)=>set('minSizeUsd', Number(e.target.value) || 0.1)}
                      disabled={!cfg.sizingEnabled} />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Max Size (USD)</label>
                    <input type="number" step="10" min="1" max="10000"
                      className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                      value={cfg.maxSizeUsd ?? 500}
                      onChange={(e)=>set('maxSizeUsd', Number(e.target.value) || 500)}
                      disabled={!cfg.sizingEnabled} />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Aggressiveness</label>
                    <input type="number" step="0.05" min="0.1" max="0.99"
                      className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                      value={cfg.aggressiveness ?? 0.70}
                      onChange={(e)=>set('aggressiveness', Number(e.target.value) || 0.70)}
                      disabled={!cfg.sizingEnabled} />
                    <div className="text-xs text-gray-400 mt-1">0.5 = conservative, 0.95 = aggressive</div>
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Max Slippage (bps)</label>
                    <input type="number" step="50" min="10" max="2000"
                      className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                      value={cfg.maxSlippageBps ?? 500}
                      onChange={(e)=>set('maxSlippageBps', Number(e.target.value) || 500)}
                      disabled={!cfg.sizingEnabled} />
                    <div className="text-xs text-gray-400 mt-1">Cap trade size when slippage exceeds this</div>
                  </div>
                </div>

                {/* Multi-Hop Optimization Sub-Section */}
                <div className="border-t border-gray-600 pt-4 mt-4">
                  <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => toggleSection('multiHop')}>
                    <h4 className="text-sm font-semibold text-gray-300">Multi-Hop Profit Optimization</h4>
                    <span className="text-gray-400 text-sm">{uiPrefs.expandedSections?.multiHop ? '▼' : '▶'}</span>
                  </div>
                  <label className="flex items-center gap-2 mb-3">
                    <input type="checkbox" checked={!!cfg.multiHopEnabled} onChange={(e)=>set('multiHopEnabled', e.target.checked)} disabled={!cfg.sizingEnabled} />
                    <span className="text-sm">Enable Multi-Hop Optimization</span>
                  </label>
                  <div className="text-xs text-gray-400 mb-3">
                    When enabled, simulates trades through all hops to find the size that maximizes profit.
                    Falls back to bottleneck method if insufficient data.
                  </div>
                  
                  {uiPrefs.expandedSections?.multiHop && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs mb-1">Optimization Method</label>
                          <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                            value={cfg.multiHopMethod ?? 'ternary_search'}
                            onChange={(e)=>set('multiHopMethod', e.target.value)}
                            disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled}>
                            <option value="ternary_search">Ternary Search</option>
                            <option value="binary_search">Binary Search</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs mb-1">Fixed Cost (USD)</label>
                          <input type="number" step="0.0001" min="0" max="0.1"
                            className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                            value={cfg.multiHopFixedCostUsd ?? 0.001}
                            onChange={(e)=>set('multiHopFixedCostUsd', Number(e.target.value) || 0.001)}
                            disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                          <div className="text-xs text-gray-400 mt-1">Gas + Jito tip estimate</div>
                        </div>
                        <div>
                          <label className="block text-xs mb-1">Safety Margin</label>
                          <input type="number" step="0.05" min="0.5" max="1.0"
                            className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                            value={cfg.multiHopSafetyMargin ?? 0.80}
                            onChange={(e)=>set('multiHopSafetyMargin', Number(e.target.value) || 0.80)}
                            disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                          <div className="text-xs text-gray-400 mt-1">0.8 = use 80% of computed optimal</div>
                        </div>
                      </div>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" 
                          checked={cfg.multiHopFallbackToBottleneck !== false} 
                          onChange={(e)=>set('multiHopFallbackToBottleneck', e.target.checked)}
                          disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                        <span className="text-sm">Fallback to bottleneck method on insufficient data</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" 
                          checked={cfg.multiHopDisableCalibration !== false} 
                          onChange={(e)=>set('multiHopDisableCalibration', e.target.checked)}
                          disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                        <span className="text-sm">Disable learned calibration</span>
                      </label>
                      <div className="text-xs text-gray-400 ml-6">
                        Prevents 6007 errors from causing sizes to drift down over time
                      </div>

                      {/* Slippage Model Parameters */}
                      <div className="border-t border-gray-600 pt-3 mt-3">
                        <h5 className="text-xs font-semibold text-gray-400 mb-3">Slippage Model Parameters</h5>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div>
                            <label className="block text-xs mb-1">AMM Reserve Multiplier</label>
                            <input type="number" step="0.05" min="0.5" max="1.0"
                              className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                              value={cfg.ammReserveMultiplier ?? 0.95}
                              onChange={(e)=>set('ammReserveMultiplier', Number(e.target.value) || 0.95)}
                              disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                            <div className="text-xs text-gray-400 mt-1">0.95 = 95% of reserves available</div>
                          </div>
                          <div>
                            <label className="block text-xs mb-1">CLMM Liquidity Decay</label>
                            <input type="number" step="0.05" min="0.3" max="0.99"
                              className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                              value={cfg.clmmLiquidityDecay ?? 0.70}
                              onChange={(e)=>set('clmmLiquidityDecay', Number(e.target.value) || 0.70)}
                              disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                            <div className="text-xs text-gray-400 mt-1">Per tick (0.7 = 30% drop each tick)</div>
                          </div>
                          <div>
                            <label className="block text-xs mb-1">DLMM Active Bin Fraction</label>
                            <input type="number" step="0.01" min="0.01" max="0.5"
                              className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm"
                              value={cfg.dlmmActiveBinFraction ?? 0.10}
                              onChange={(e)=>set('dlmmActiveBinFraction', Number(e.target.value) || 0.10)}
                              disabled={!cfg.multiHopEnabled || !cfg.sizingEnabled} />
                            <div className="text-xs text-gray-400 mt-1">TVL fraction in active bin</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Arb Graph Edges</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="col-span-1">
                <div className="font-semibold mb-2">Raydium</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.raydium?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, raydium: { ...(cfg.edge_allow?.raydium||{}), amm: e.target.checked } })} />AMM</label>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.raydium?.clmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, raydium: { ...(cfg.edge_allow?.raydium||{}), clmm: e.target.checked } })} />CLMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.edge_allow?.raydium?.cpmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, raydium: { ...(cfg.edge_allow?.raydium||{}), cpmm: e.target.checked } })} />CPMM</label>
              </div>
              <div className="col-span-1">
                <div className="font-semibold mb-2">Orca</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.orca?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, orca: { ...(cfg.edge_allow?.orca||{}), amm: e.target.checked } })} />AMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.edge_allow?.orca?.clmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, orca: { ...(cfg.edge_allow?.orca||{}), clmm: e.target.checked } })} />Whirlpool</label>
              </div>
              <div className="col-span-1">
                <div className="font-semibold mb-2">Meteora</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.meteora?.clmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, meteora: { ...(cfg.edge_allow?.meteora||{}), clmm: e.target.checked } })} />DLMM</label>
                <div className="ml-4 mt-1 mb-1 text-sm font-medium">Balanced</div>
                <label className="flex items-center gap-2 ml-4 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.meteoraBalanced?.v1} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, meteoraBalanced: { ...(cfg.edge_allow?.meteoraBalanced||{}), v1: e.target.checked } })} />v1</label>
                <label className="flex items-center gap-2 ml-4"><input type="checkbox" checked={!!cfg.edge_allow?.meteoraBalanced?.v2} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, meteoraBalanced: { ...(cfg.edge_allow?.meteoraBalanced||{}), v2: e.target.checked } })} />v2</label>
              </div>
              <div className="col-span-1">
                <div className="font-semibold mb-2">Pumpswap</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.pumpswap?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, pumpswap: { ...(cfg.edge_allow?.pumpswap||{}), amm: e.target.checked } })} />AMM</label>
              </div>
            </div>
            <div className="text-xs opacity-70 mt-3">Uncheck to exclude edges from the arbitrage graph. Changes take effect on save.</div>
          </div>

          <div className="flex justify-end gap-3">
            <button className="px-4 py-2 bg-gray-600 rounded text-white" onClick={onClose} disabled={saving}>Cancel</button>
            <button className={`px-4 py-2 ${saving?'bg-blue-500/60':'bg-blue-600 hover:bg-blue-700'} rounded text-white`} onClick={onSave} disabled={saving}>{saving?'Saving…':'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};


