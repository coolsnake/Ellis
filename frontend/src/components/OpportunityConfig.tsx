import React, { useEffect, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useModalConfig } from '../app/hooks/useModalConfig';

type Props = { apiBase: string; onClose: () => void };

export const OpportunityConfig: React.FC<Props> = ({ apiBase, onClose }) => {
  // Persist ALL configuration values to localStorage
  const [uiPrefs, updateUiPrefs] = useModalConfig('opportunityConfig', {
    lastValues: null as any,
  });
  
  const [det, setDet] = useState<any>(uiPrefs.lastValues || {});
  const [execMode, setExecMode] = useState<'simulate'|'direct'>('simulate');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: any) => setDet((p: any) => ({ ...p, [k]: v }));
  
  // Save ALL configuration values to localStorage when they change
  useEffect(() => {
    updateUiPrefs({ lastValues: det });
  }, [det]);

  useEffect(() => {
    (async () => {
      try { 
        const r = await fetch(`${apiBase}${ROUTES.arb.config}`); 
        if (r.ok) {
          const j = await r.json();
          // Pre-format anchor_mints as CSV for the input field
          const anchorMintsCsv = Array.isArray(j.anchor_mints) 
            ? j.anchor_mints.join(', ') 
            : '';
          setDet({ ...j, anchor_mints_csv: anchorMintsCsv });
        }
      } catch {}
      try { const r = await fetch(`${apiBase}${ROUTES.exec.config}`); if (r.ok) { const j = await r.json(); setExecMode((j?.mode === 'direct') ? 'direct' : 'simulate'); } } catch {}
      try { 
        const r = await fetch(`${apiBase}/arb/executor/config`); 
        if (r.ok) { 
          const j = await r.json(); 
          // Load executor-specific settings
          if (typeof j.requireStartBalance === 'boolean') {
            set('require_start_balance', j.requireStartBalance);
          }
          if (typeof j.minProfitBps === 'number') {
            set('executor_min_profit_bps', j.minProfitBps);
          }
          if (typeof j.maxHops === 'number') {
            set('executor_max_hops', j.maxHops);
          }
          if (typeof j.sizeUsd === 'number') {
            set('executor_size_usd', j.sizeUsd);
          }
          if (typeof j.slippageBps === 'number') {
            set('executor_slippage_bps', j.slippageBps);
          }
          if (typeof j.minReservesUsd === 'number') {
            set('executor_min_reserves_usd', j.minReservesUsd);
          }
          if (typeof j.maxExecutionsPerMinute === 'number') {
            set('executor_max_per_minute', j.maxExecutionsPerMinute);
          }
          // Load dynamic sizing config
          if (j.dynamicSizing) {
            set('dynamic_sizing_enabled', !!j.dynamicSizing.enabled);
            set('sizing_method', j.dynamicSizing.method || 'heuristic');
            if (typeof j.dynamicSizing.minSizeUsd === 'number') {
              set('dynamic_sizing_min_usd', j.dynamicSizing.minSizeUsd);
            }
            if (typeof j.dynamicSizing.maxSizeUsd === 'number') {
              set('dynamic_sizing_max_usd', j.dynamicSizing.maxSizeUsd);
            }
            if (typeof j.dynamicSizing.bottleneckFraction === 'number') {
              set('dynamic_sizing_bottleneck_fraction', j.dynamicSizing.bottleneckFraction);
            }
            if (typeof j.dynamicSizing.profitScaling === 'boolean') {
              set('dynamic_sizing_profit_scaling', j.dynamicSizing.profitScaling);
            }
            // Load optimal sizing settings
            if (j.dynamicSizing.optimalSettings) {
              const os = j.dynamicSizing.optimalSettings;
              if (typeof os.safetyFactor === 'number') set('optimal_safety_factor', os.safetyFactor);
              if (typeof os.ammSlippageMultiplier === 'number') set('optimal_amm_multiplier', os.ammSlippageMultiplier);
              if (typeof os.clmmSlippageMultiplier === 'number') set('optimal_clmm_multiplier', os.clmmSlippageMultiplier);
              if (typeof os.dlmmSlippageMultiplier === 'number') set('optimal_dlmm_multiplier', os.dlmmSlippageMultiplier);
              if (typeof os.iterativeMaxIterations === 'number') set('optimal_max_iterations', os.iterativeMaxIterations);
              if (typeof os.iterativeTolerance === 'number') set('optimal_tolerance', os.iterativeTolerance);
            }
          }
          // Load flashloan settings
          if (j.flashloanSettings) {
            set('flashloan_enabled', !!j.flashloanSettings.enabled);
            if (j.flashloanSettings.preferredToken) {
              set('flashloan_preferred_token', j.flashloanSettings.preferredToken);
            }
            if (typeof j.flashloanSettings.minProfitForFlashloan === 'number') {
              set('flashloan_min_profit', j.flashloanSettings.minProfitForFlashloan);
            }
            if (typeof j.flashloanSettings.maxFlashloanUsd === 'number') {
              set('flashloan_max_usd', j.flashloanSettings.maxFlashloanUsd);
            }
            if (typeof j.flashloanSettings.accountForFee === 'boolean') {
              set('flashloan_account_for_fee', j.flashloanSettings.accountForFee);
            }
            if (typeof j.flashloanSettings.fallbackToWallet === 'boolean') {
              set('flashloan_fallback_wallet', j.flashloanSettings.fallbackToWallet);
            }
          }
          // Load router settings
          if (typeof j.useRouter === 'boolean') {
            set('use_router', j.useRouter);
          }
          // Load quarantine settings
          if (j.quarantineSettings) {
            set('quarantine_enabled', !!j.quarantineSettings.enabled);
            if (typeof j.quarantineSettings.maxFailures === 'number') {
              set('quarantine_max_failures', j.quarantineSettings.maxFailures);
            }
            if (typeof j.quarantineSettings.windowMs === 'number') {
              set('quarantine_window_sec', Math.round(j.quarantineSettings.windowMs / 1000));
            }
            if (typeof j.quarantineSettings.quarantineDurationMs === 'number') {
              set('quarantine_duration_sec', Math.round(j.quarantineSettings.quarantineDurationMs / 1000));
            }
          }
          // Load manual pool blocklist
          if (Array.isArray(j.manualPoolBlocklist)) {
            set('manual_pool_blocklist_csv', j.manualPoolBlocklist.join(', '));
          }
        } 
      } catch {}
      // Load Jito config
      try {
        const r = await fetch(`${apiBase}/arb/jito/config`);
        if (r.ok) {
          const j = await r.json();
          if (typeof j.enabled === 'boolean') set('jito_enabled', j.enabled);
          if (j.tipMode) set('jito_tip_mode', j.tipMode);
          if (typeof j.tipShare === 'number') set('jito_tip_share', j.tipShare);
          if (typeof j.minTipLamports === 'number') set('jito_min_tip_lamports', j.minTipLamports);
          if (typeof j.maxTipLamports === 'number') set('jito_max_tip_lamports', j.maxTipLamports);
          if (typeof j.fixedTipLamports === 'number') set('jito_fixed_tip_lamports', j.fixedTipLamports);
        }
      } catch {}
    })();
  }, [apiBase]);

  const toNum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const toOptNum = (v: any) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : undefined; };

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
    const body: any = {
      enabled: !!det.enabled,
      min_profit_bps: toNum(det.min_profit_bps),
      max_profit_bps: toOptNum(det.max_profit_bps),
      min_notional_usd: toNum(det.min_notional_usd),
      max_hops: (() => {
        const val = toNum(det.max_hops);
        // If 0 or invalid, default to 4 (current default)
        return val > 0 ? val : 4;
      })(),
      quote_size_usd: toNum(det.quote_size_usd),
      max_idle_ms: toOptNum(det.max_idle_ms),
      // near-miss & debug
      near_miss_enable: !!det.near_miss_enable,
      near_miss_epsilon: Number(det.near_miss_epsilon ?? 0.0005),
      debug_emit_subthreshold: !!det.debug_emit_subthreshold,
      debug_top_n: toOptNum(det.debug_top_n),
      debug_near_miss_failures: !!det.debug_near_miss_failures,
      // fee netting
      est_priority_fee_per_hop_lamports: toOptNum(det.est_priority_fee_per_hop_lamports),
      // cadence/perf
      filtered_detect_enable: !!det.filtered_detect_enable,
      // Start mint mode: "any", "sol_usdc", or "anchors"
      start_mint_mode: det.start_mint_mode || 'any',
      // Custom anchor mints (used when start_mint_mode is "anchors")
      // Only send if there are actual mints configured
      ...((() => {
        const mints = String(det.anchor_mints_csv || '')
          .split(',').map(s => s.trim()).filter(Boolean);
        return mints.length > 0 ? { anchor_mints: mints } : {};
      })()),
      filtered_node_ratio: toOptNum(det.filtered_node_ratio),
      filtered_expand_hops: toOptNum(det.filtered_expand_hops),
      periodic_full_ms: toOptNum(det.periodic_full_ms),
      // path pruning
      // Don't send max_sol_stable_hops if it's a huge number (usize::MAX from Rust loses precision in JS)
      ...((() => {
        const val = toOptNum(det.max_sol_stable_hops);
        // Only send if it's a reasonable value (not usize::MAX which gets corrupted by JS float precision)
        return val !== undefined && val < 1000000 ? { max_sol_stable_hops: val } : {};
      })()),
      drop_stable_stable_hops: !!det.drop_stable_stable_hops,
      // Only send stable_mints if there are actual values
      ...((() => {
        const mints = String(det.stable_mints_csv || '')
          .split(',').map(s => s.trim()).filter(Boolean);
        return mints.length > 0 ? { stable_mints: mints } : {};
      })()),
    };
    try {
      console.log('[OpportunityConfig] Saving arb config:', body);
      const [r1, r2, r3, r4] = await Promise.all([
        fetch(`${apiBase}${ROUTES.arb.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        fetch(`${apiBase}${ROUTES.exec.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: execMode }) }),
        fetch(`${apiBase}/arb/executor/config`, { 
          method: 'POST', 
          headers: { 'content-type': 'application/json' }, 
          body: JSON.stringify({ 
            requireStartBalance: !!det.require_start_balance,
            minProfitBps: toNum(det.executor_min_profit_bps),
            maxHops: toOptNum(det.executor_max_hops),
            sizeUsd: toOptNum(det.executor_size_usd),
            slippageBps: toOptNum(det.executor_slippage_bps),
            minReservesUsd: toOptNum(det.executor_min_reserves_usd),
            maxExecutionsPerMinute: toOptNum(det.executor_max_per_minute),
            // Dynamic sizing config
            dynamicSizing: {
              enabled: !!det.dynamic_sizing_enabled,
              minSizeUsd: toNum(det.dynamic_sizing_min_usd) || 5,
              maxSizeUsd: toNum(det.dynamic_sizing_max_usd) || 200,
              method: det.sizing_method || 'heuristic',
              // Heuristic settings
              bottleneckFraction: Number(det.dynamic_sizing_bottleneck_fraction) || 0.10,
              profitScaling: det.dynamic_sizing_profit_scaling !== false,
              // Optimal sizing settings
              optimalSettings: {
                ammSlippageMultiplier: Number(det.optimal_amm_multiplier) || 2.0,
                clmmSlippageMultiplier: Number(det.optimal_clmm_multiplier) || 3.0,
                dlmmSlippageMultiplier: Number(det.optimal_dlmm_multiplier) || 1.3,
                iterativeMaxIterations: toNum(det.optimal_max_iterations) || 15,
                iterativeTolerance: Number(det.optimal_tolerance) || 1.0,
                safetyFactor: Number(det.optimal_safety_factor) || 0.85,
              },
            },
            // Flashloan settings
            flashloanSettings: {
              enabled: !!det.flashloan_enabled,
              preferredToken: det.flashloan_preferred_token || 'auto',
              minProfitForFlashloan: Number(det.flashloan_min_profit) || 0.50,
              maxFlashloanUsd: Number(det.flashloan_max_usd) || 10000,
              accountForFee: det.flashloan_account_for_fee !== false,
              fallbackToWallet: det.flashloan_fallback_wallet !== false,
            },
            // Router settings - use on-chain router for execution
            useRouter: !!det.use_router,
            // Quarantine settings
            quarantineSettings: {
              enabled: det.quarantine_enabled !== false,
              maxFailures: toNum(det.quarantine_max_failures) || 5,
              windowMs: (toNum(det.quarantine_window_sec) || 300) * 1000,
              quarantineDurationMs: (toNum(det.quarantine_duration_sec) || 900) * 1000,
            },
            // Manual pool blocklist
            manualPoolBlocklist: String(det.manual_pool_blocklist_csv || '')
              .split(',').map((s: string) => s.trim()).filter(Boolean),
          }) 
        }),
        // Save Jito config
        fetch(`${apiBase}/arb/jito/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled: det.jito_enabled !== false,
            tipMode: det.jito_tip_mode || 'dynamic',
            tipShare: Number(det.jito_tip_share) || 0.35,
            minTipLamports: toNum(det.jito_min_tip_lamports) || 10000,
            maxTipLamports: toNum(det.jito_max_tip_lamports) || 5_000_000,
            fixedTipLamports: toNum(det.jito_fixed_tip_lamports) || 10000,
          }),
        }),
      ]);
      // Check each response and build detailed error message
      const errors: string[] = [];
      if (!r1.ok) {
        const txt = await r1.text().catch(() => '');
        errors.push(`arb/config: ${r1.status} ${txt.slice(0, 100)}`);
      }
      if (!r2.ok) {
        const txt = await r2.text().catch(() => '');
        errors.push(`exec/config: ${r2.status} ${txt.slice(0, 100)}`);
      }
      if (!r3.ok) {
        const txt = await r3.text().catch(() => '');
        errors.push(`executor/config: ${r3.status} ${txt.slice(0, 100)}`);
      }
      if (!r4.ok) {
        const txt = await r4.text().catch(() => '');
        errors.push(`jito/config: ${r4.status} ${txt.slice(0, 100)}`);
      }
      if (errors.length > 0) throw new Error(errors.join('; '));
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Opportunity Configuration</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {error ? <div className="text-red-400 text-sm mb-2">{error}</div> : null}

        <div className="space-y-6 text-sm">
          <div className="flex items-center gap-2">
            <input id="opp-enabled" type="checkbox" className="w-4 h-4" checked={!!det.enabled} onChange={e=>set('enabled', e.target.checked)} />
            <label htmlFor="opp-enabled" className="text-gray-300">Enable detection</label>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold text-white mb-3">Detection thresholds</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block mb-1 text-gray-300">Min Profit (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.min_profit_bps ?? ''} onChange={e=>set('min_profit_bps', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Max Profit (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.max_profit_bps ?? ''} onChange={e=>set('max_profit_bps', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Min Notional (USD)</label><input type="number" step="1" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.min_notional_usd ?? ''} onChange={e=>set('min_notional_usd', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Max Hops</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.max_hops ?? ''} onChange={e=>set('max_hops', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Quote Size (USD)</label><input type="number" step="1" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.quote_size_usd ?? ''} onChange={e=>set('quote_size_usd', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Max Idle (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.max_idle_ms ?? ''} onChange={e=>set('max_idle_ms', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold text-white mb-3">Near-miss & Debug</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2 md:col-span-1"><input type="checkbox" checked={!!det.near_miss_enable} onChange={e=>set('near_miss_enable', e.target.checked)} />Enable near-miss</label>
              <div><label className="block mb-1 text-gray-300">Near-miss epsilon</label><input type="number" step={0.0001} className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.near_miss_epsilon ?? 0.0005} onChange={e=>set('near_miss_epsilon', Number(e.target.value)||0.0005)} /></div>
              <label className="flex items-center gap-2 md:col-span-1"><input type="checkbox" checked={!!det.debug_emit_subthreshold} onChange={e=>set('debug_emit_subthreshold', e.target.checked)} />Emit sub-threshold</label>
              <div><label className="block mb-1 text-gray-300">Debug Top-N</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.debug_top_n ?? 5} onChange={e=>set('debug_top_n', Number(e.target.value)||5)} /></div>
              <label className="flex items-center gap-2 md:col-span-1"><input type="checkbox" checked={!!det.debug_near_miss_failures} onChange={e=>set('debug_near_miss_failures', e.target.checked)} />Log near-miss failures</label>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold text-white mb-3">Fee netting</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block mb-1 text-gray-300">Est. priority fee per hop (lamports)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.est_priority_fee_per_hop_lamports ?? ''} onChange={e=>set('est_priority_fee_per_hop_lamports', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold text-white mb-3">Cadence & Performance</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!det.filtered_detect_enable} onChange={e=>set('filtered_detect_enable', e.target.checked)} />Enable filtered detection</label>
              
              {/* Start Mint Mode dropdown */}
              <div className="md:col-span-2">
                <label className="block mb-1 text-gray-300">Cycle Start Mode</label>
                <select 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                  value={det.start_mint_mode || 'any'}
                  onChange={e=>set('start_mint_mode', e.target.value)}
                >
                  <option value="any">Any mint (full scan)</option>
                  <option value="sol_usdc">SOL & USDC only</option>
                  <option value="anchors">Custom anchors</option>
                </select>
              </div>
              
              <div><label className="block mb-1 text-gray-300">Node ratio</label><input type="number" step={0.01} className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.filtered_node_ratio ?? ''} onChange={e=>set('filtered_node_ratio', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Expand hops</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.filtered_expand_hops ?? ''} onChange={e=>set('filtered_expand_hops', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Periodic full (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.periodic_full_ms ?? ''} onChange={e=>set('periodic_full_ms', Number(e.target.value)||0)} /></div>
              
              {/* Custom anchors input - only shown when "anchors" mode selected */}
              {det.start_mint_mode === 'anchors' && (
                <div className="md:col-span-4">
                  <label className="block mb-1 text-gray-300">
                    Anchor Mints (comma-separated)
                    <span className="text-xs text-gray-500 ml-2">Cycles will only start from these tokens</span>
                  </label>
                  <input 
                    type="text" 
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 font-mono text-xs" 
                    placeholder="So11111111111111111111111111111111111111112, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                    value={det.anchor_mints_csv ?? (Array.isArray(det.anchor_mints) ? det.anchor_mints.join(', ') : '')} 
                    onChange={e=>set('anchor_mints_csv', e.target.value)} 
                  />
                </div>
              )}
            </div>
            
            {/* Mode explanation */}
            <div className="mt-3 text-xs text-gray-400">
              {(det.start_mint_mode || 'any') === 'any' && (
                <span><strong>Full scan:</strong> Detects cycles starting from any token. More comprehensive but slower.</span>
              )}
              {det.start_mint_mode === 'sol_usdc' && (
                <span><strong>SOL & USDC:</strong> Only detects cycles that start from SOL or USDC. Faster, focuses on high-liquidity paths.</span>
              )}
              {det.start_mint_mode === 'anchors' && (
                <span><strong>Custom anchors:</strong> Only detects cycles starting from specified tokens. Configure anchors above.</span>
              )}
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold text-white mb-3">Path Pruning</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!det.drop_stable_stable_hops} onChange={e=>set('drop_stable_stable_hops', e.target.checked)} />Drop stable↔stable hops</label>
              <div><label className="block mb-1 text-gray-300">Max SOL↔stable hops</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.max_sol_stable_hops ?? ''} onChange={e=>set('max_sol_stable_hops', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Stable mints (CSV)</label><input type="text" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.stable_mints_csv ?? (Array.isArray(det.stable_mints) ? det.stable_mints.join(',') : '')} onChange={e=>set('stable_mints_csv', e.target.value)} placeholder="EPjF...,Es9v...," /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4 border-2 border-blue-500/30">
            <h3 className="text-lg font-semibold text-white mb-2">Executor Filters (Post-Detection)</h3>
            <p className="text-xs text-gray-400 mb-3">
              These filters apply <strong>after</strong> detection. Set detection thresholds lower and execution thresholds higher to see near-miss opportunities.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block mb-1 text-gray-300">Min Profit for Execution (bps)</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_min_profit_bps ?? 50} 
                  onChange={e=>set('executor_min_profit_bps', Number(e.target.value)||0)} 
                />
              </div>
              <div>
                <label className="block mb-1 text-gray-300">Max Hops for Execution</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_max_hops ?? 3} 
                  onChange={e=>set('executor_max_hops', Number(e.target.value)||0)} 
                />
              </div>
              <div>
                <label className="block mb-1 text-gray-300">Slippage (bps)</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_slippage_bps ?? 50} 
                  onChange={e=>set('executor_slippage_bps', Number(e.target.value)||0)} 
                />
              </div>
              <div>
                <label className="block mb-1 text-gray-300">Min Reserves (USD)</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_min_reserves_usd ?? 10000} 
                  onChange={e=>set('executor_min_reserves_usd', Number(e.target.value)||0)} 
                />
              </div>
              <div>
                <label className="block mb-1 text-gray-300">Max Executions/Min</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_max_per_minute ?? 10} 
                  onChange={e=>set('executor_max_per_minute', Number(e.target.value)||0)} 
                />
              </div>
            </div>
          </div>

          {/* Trade Size Optimization Section */}
          <div className="bg-gray-700 rounded p-4 border-2 border-emerald-500/30">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">Trade Size Optimization</h3>
              <label className="flex items-center gap-2 text-sm">
                <input 
                  type="checkbox" 
                  className="w-4 h-4"
                  checked={!!det.dynamic_sizing_enabled} 
                  onChange={e=>set('dynamic_sizing_enabled', e.target.checked)} 
                />
                <span className="text-emerald-400">Enabled</span>
              </label>
            </div>
            
            {/* Sizing Method Selection */}
            <div className={`mb-4 ${!det.dynamic_sizing_enabled ? 'opacity-50 pointer-events-none' : ''}`}>
              <label className="block mb-2 text-gray-300 text-sm font-medium">Sizing Method</label>
              <div className="flex gap-2">
                {[
                  { value: 'heuristic', label: 'Heuristic', desc: 'Simple fraction of bottleneck' },
                  { value: 'optimal_analytical', label: 'Optimal (Analytical)', desc: 'Closed-form profit max' },
                  { value: 'optimal_iterative', label: 'Optimal (Iterative)', desc: 'Search-based profit max' }
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => set('sizing_method', opt.value)}
                    disabled={!det.dynamic_sizing_enabled}
                    className={`flex-1 p-2 rounded border text-sm transition-all ${
                      (det.sizing_method || 'heuristic') === opt.value
                        ? 'bg-emerald-600/30 border-emerald-500 text-emerald-300'
                        : 'bg-gray-600 border-gray-500 text-gray-300 hover:border-gray-400'
                    }`}
                  >
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-xs text-gray-400 mt-1">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Common Size Bounds */}
            <div className={`grid grid-cols-2 gap-4 mb-4 ${!det.dynamic_sizing_enabled ? 'opacity-50' : ''}`}>
              <div>
                <label className="block mb-1 text-gray-300">
                  Min Size (USD)
                  <span className="text-xs text-gray-500 ml-2">Floor</span>
                </label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.dynamic_sizing_min_usd ?? 5} 
                  onChange={e=>set('dynamic_sizing_min_usd', Number(e.target.value)||5)} 
                  disabled={!det.dynamic_sizing_enabled}
                />
              </div>
              <div>
                <label className="block mb-1 text-gray-300">
                  Max Size (USD)
                  <span className="text-xs text-gray-500 ml-2">Ceiling</span>
                </label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.dynamic_sizing_max_usd ?? 200} 
                  onChange={e=>set('dynamic_sizing_max_usd', Number(e.target.value)||200)} 
                  disabled={!det.dynamic_sizing_enabled}
                />
              </div>
            </div>

            {/* Heuristic Settings */}
            {(det.sizing_method || 'heuristic') === 'heuristic' && det.dynamic_sizing_enabled && (
              <div className="bg-gray-800/50 rounded p-3 mb-4">
                <h4 className="text-sm font-medium text-gray-300 mb-3">Heuristic Settings</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block mb-1 text-gray-400 text-sm">
                      Bottleneck Fraction
                      <span className="text-xs text-gray-500 ml-2">0.10 = 10%</span>
                    </label>
                    <input 
                      type="number" 
                      step="0.01"
                      min="0.01"
                      max="0.50"
                      className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                      value={det.dynamic_sizing_bottleneck_fraction ?? 0.10} 
                      onChange={e=>set('dynamic_sizing_bottleneck_fraction', Number(e.target.value)||0.10)} 
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2">
                      <input 
                        type="checkbox" 
                        className="w-4 h-4"
                        checked={det.dynamic_sizing_profit_scaling !== false} 
                        onChange={e=>set('dynamic_sizing_profit_scaling', e.target.checked)} 
                      />
                      <span className="text-gray-300 text-sm">
                        Scale by profit margin
                      </span>
                    </label>
                  </div>
                </div>
                {/* Heuristic example */}
                <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                  {[1000, 5000, 10000, 50000].map(bottleneck => (
                    <div key={bottleneck} className="bg-gray-700/50 p-2 rounded">
                      <div className="text-gray-500">${(bottleneck/1000).toFixed(0)}K bottleneck</div>
                      <div className="text-emerald-400 font-mono">
                        ${Math.max(det.dynamic_sizing_min_usd || 5, Math.min(det.dynamic_sizing_max_usd || 200, bottleneck * (det.dynamic_sizing_bottleneck_fraction || 0.10))).toFixed(0)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Optimal Sizing Settings */}
            {(det.sizing_method === 'optimal_analytical' || det.sizing_method === 'optimal_iterative') && det.dynamic_sizing_enabled && (
              <div className="bg-gray-800/50 rounded p-3 mb-4">
                <h4 className="text-sm font-medium text-amber-300 mb-3">
                  {det.sizing_method === 'optimal_analytical' ? 'Analytical' : 'Iterative'} Optimal Settings
                </h4>
                
                {/* Safety Factor */}
                <div className="mb-4">
                  <label className="block mb-1 text-gray-400 text-sm">
                    Safety Factor
                    <span className="text-xs text-gray-500 ml-2">Scales down from calculated optimal</span>
                  </label>
                  <input 
                    type="range"
                    min="0.5"
                    max="1.0"
                    step="0.05"
                    className="w-full accent-emerald-500"
                    value={det.optimal_safety_factor ?? 0.85}
                    onChange={e=>set('optimal_safety_factor', Number(e.target.value))}
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>50% (Very Safe)</span>
                    <span className="text-emerald-400 font-mono text-sm">{((det.optimal_safety_factor ?? 0.85) * 100).toFixed(0)}%</span>
                    <span>100% (Full Optimal)</span>
                  </div>
                </div>

                {/* Slippage Multipliers */}
                <div className="mb-4">
                  <label className="block mb-2 text-gray-400 text-sm">Slippage Model Multipliers</label>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block mb-1 text-gray-500 text-xs">AMM (xy=k)</label>
                      <input 
                        type="number" 
                        step="0.1"
                        min="1.0"
                        max="5.0"
                        className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" 
                        value={det.optimal_amm_multiplier ?? 2.0} 
                        onChange={e=>set('optimal_amm_multiplier', Number(e.target.value)||2.0)} 
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-gray-500 text-xs">CLMM (Orca/Ray)</label>
                      <input 
                        type="number" 
                        step="0.1"
                        min="1.0"
                        max="5.0"
                        className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" 
                        value={det.optimal_clmm_multiplier ?? 3.0} 
                        onChange={e=>set('optimal_clmm_multiplier', Number(e.target.value)||3.0)} 
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-gray-500 text-xs">DLMM (Meteora)</label>
                      <input 
                        type="number" 
                        step="0.1"
                        min="1.0"
                        max="5.0"
                        className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" 
                        value={det.optimal_dlmm_multiplier ?? 1.3} 
                        onChange={e=>set('optimal_dlmm_multiplier', Number(e.target.value)||1.3)} 
                      />
                    </div>
                  </div>
                </div>

                {/* Iterative-specific settings */}
                {det.sizing_method === 'optimal_iterative' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block mb-1 text-gray-500 text-xs">Max Iterations</label>
                      <input 
                        type="number" 
                        min="5"
                        max="30"
                        className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" 
                        value={det.optimal_max_iterations ?? 15} 
                        onChange={e=>set('optimal_max_iterations', Number(e.target.value)||15)} 
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-gray-500 text-xs">Tolerance (USD)</label>
                      <input 
                        type="number" 
                        step="0.5"
                        min="0.5"
                        max="10"
                        className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 text-sm" 
                        value={det.optimal_tolerance ?? 1.0} 
                        onChange={e=>set('optimal_tolerance', Number(e.target.value)||1.0)} 
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Method Explanation */}
            {det.dynamic_sizing_enabled && (
              <div className="p-3 bg-gray-800/30 rounded text-xs text-gray-400">
                {(det.sizing_method || 'heuristic') === 'heuristic' && (
                  <>
                    <strong className="text-gray-300">Heuristic Mode:</strong> Size = bottleneckLiquidity × fraction × profitMultiplier.
                    Fast but may leave profit on the table.
                  </>
                )}
                {det.sizing_method === 'optimal_analytical' && (
                  <>
                    <strong className="text-amber-300">Optimal (Analytical):</strong> Uses closed-form formulas to calculate 
                    profit-maximizing size. Formula: Δ* = R × (√rate_product - 1) / γ. Best for AMM-only paths.
                  </>
                )}
                {det.sizing_method === 'optimal_iterative' && (
                  <>
                    <strong className="text-purple-300">Optimal (Iterative):</strong> Uses golden section search to find 
                    the exact profit peak. Handles mixed pool types (AMM/CLMM/DLMM) accurately. Slightly slower.
                  </>
                )}
              </div>
            )}
          </div>

          {/* On-chain Router Execution */}
          <div className="bg-gray-700 rounded p-4 border-2 border-purple-500/30">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">On-chain Router Execution</h3>
              <label className="flex items-center gap-2 text-sm">
                <input 
                  type="checkbox" 
                  className="w-4 h-4"
                  checked={!!det.use_router} 
                  onChange={e=>set('use_router', e.target.checked)} 
                />
                <span className="text-purple-400">Enabled</span>
              </label>
            </div>
            
            <p className="text-xs text-gray-400">
              Route swaps through the deployed on-chain router program instead of building 
              direct DEX instructions. Required for flashloans. The router must be deployed 
              and enabled in Router Config.
            </p>
          </div>

          {/* Flashloan Settings Section */}
          <div className="bg-gray-700 rounded p-4 border-2 border-blue-500/30">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">Flashloan Boost</h3>
              <label className="flex items-center gap-2 text-sm">
                <input 
                  type="checkbox" 
                  className="w-4 h-4"
                  checked={!!det.flashloan_enabled} 
                  onChange={e=>set('flashloan_enabled', e.target.checked)} 
                />
                <span className="text-blue-400">Enabled</span>
              </label>
            </div>
            
            <p className="text-xs text-gray-400 mb-3">
              Use flashloans when optimal trade size exceeds wallet balance.
              Fee: <span className="text-amber-400 font-mono">9 bps (0.09%)</span> of borrowed amount.
            </p>
            
            <div className={`space-y-4 ${!det.flashloan_enabled ? 'opacity-50 pointer-events-none' : ''}`}>
              {/* Preferred Token */}
              <div>
                <label className="block mb-2 text-gray-300 text-sm font-medium">Flashloan Token</label>
                <div className="flex gap-2">
                  {[
                    { value: 'auto', label: 'Auto', desc: 'Match cycle start' },
                    { value: 'SOL', label: 'SOL', desc: 'Use SOL vault' },
                    { value: 'USDC', label: 'USDC', desc: 'Use USDC vault' }
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => set('flashloan_preferred_token', opt.value)}
                      disabled={!det.flashloan_enabled}
                      className={`flex-1 p-2 rounded border text-sm transition-all ${
                        (det.flashloan_preferred_token || 'auto') === opt.value
                          ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                          : 'bg-gray-600 border-gray-500 text-gray-300 hover:border-gray-400'
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-xs text-gray-400">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Thresholds */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block mb-1 text-gray-300 text-sm">
                    Min Profit for Flashloan (USD)
                    <span className="text-xs text-gray-500 ml-2">Must cover fee</span>
                  </label>
                  <input 
                    type="number" 
                    step="0.1"
                    min="0"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.flashloan_min_profit ?? 0.50} 
                    onChange={e=>set('flashloan_min_profit', Number(e.target.value)||0)} 
                    disabled={!det.flashloan_enabled}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-gray-300 text-sm">
                    Max Flashloan (USD)
                    <span className="text-xs text-gray-500 ml-2">Cap on borrowed amount</span>
                  </label>
                  <input 
                    type="number" 
                    step="100"
                    min="100"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.flashloan_max_usd ?? 10000} 
                    onChange={e=>set('flashloan_max_usd', Number(e.target.value)||10000)} 
                    disabled={!det.flashloan_enabled}
                  />
                </div>
              </div>

              {/* Options */}
              <div className="flex gap-4 flex-wrap">
                <label className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    className="w-4 h-4"
                    checked={det.flashloan_account_for_fee !== false} 
                    onChange={e=>set('flashloan_account_for_fee', e.target.checked)} 
                    disabled={!det.flashloan_enabled}
                  />
                  <span className="text-gray-300 text-sm">Subtract fee from profit calc</span>
                </label>
                <label className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    className="w-4 h-4"
                    checked={det.flashloan_fallback_wallet !== false} 
                    onChange={e=>set('flashloan_fallback_wallet', e.target.checked)} 
                    disabled={!det.flashloan_enabled}
                  />
                  <span className="text-gray-300 text-sm">Fallback to wallet if unavailable</span>
                </label>
              </div>

              {/* Fee example */}
              {det.flashloan_enabled && (
                <div className="p-3 bg-gray-800/50 rounded text-xs text-gray-400">
                  <strong className="text-gray-300">Fee Examples (9 bps):</strong>
                  <div className="grid grid-cols-4 gap-2 mt-2">
                    {[100, 500, 1000, 5000].map(amt => (
                      <div key={amt} className="bg-gray-700/50 p-2 rounded">
                        <div className="text-gray-500">${amt} loan</div>
                        <div className="text-amber-400 font-mono">
                          ${(amt * 0.0009).toFixed(3)} fee
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Pool Quarantine Settings Section */}
          <div className="bg-gray-700 rounded p-4 border-2 border-orange-500/30">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">Pool Quarantine</h3>
              <label className="flex items-center gap-2 text-sm">
                <input 
                  type="checkbox" 
                  className="w-4 h-4"
                  checked={det.quarantine_enabled !== false} 
                  onChange={e=>set('quarantine_enabled', e.target.checked)} 
                />
                <span className="text-orange-400">Auto-Quarantine</span>
              </label>
            </div>
            
            <p className="text-xs text-gray-400 mb-3">
              Automatically quarantine pools that cause repeated transaction failures. 
              Quarantined pools are temporarily excluded from opportunities.
            </p>
            
            {/* Auto-quarantine settings */}
            <div className={`space-y-4 ${det.quarantine_enabled === false ? 'opacity-50 pointer-events-none' : ''}`}>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block mb-1 text-gray-300 text-sm">
                    Max Failures
                    <span className="text-xs text-gray-500 ml-1">before quarantine</span>
                  </label>
                  <input 
                    type="number" 
                    min="1"
                    max="20"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.quarantine_max_failures ?? 5} 
                    onChange={e=>set('quarantine_max_failures', Number(e.target.value)||5)} 
                    disabled={det.quarantine_enabled === false}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-gray-300 text-sm">
                    Window (seconds)
                    <span className="text-xs text-gray-500 ml-1">failure counting</span>
                  </label>
                  <input 
                    type="number" 
                    min="60"
                    step="60"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.quarantine_window_sec ?? 300} 
                    onChange={e=>set('quarantine_window_sec', Number(e.target.value)||300)} 
                    disabled={det.quarantine_enabled === false}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-gray-300 text-sm">
                    Duration (seconds)
                    <span className="text-xs text-gray-500 ml-1">quarantine time</span>
                  </label>
                  <input 
                    type="number" 
                    min="60"
                    step="60"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.quarantine_duration_sec ?? 900} 
                    onChange={e=>set('quarantine_duration_sec', Number(e.target.value)||900)} 
                    disabled={det.quarantine_enabled === false}
                  />
                </div>
              </div>
              
              <div className="p-2 bg-gray-800/50 rounded text-xs text-gray-400">
                With these settings: A pool causing <strong className="text-orange-300">{det.quarantine_max_failures ?? 5}</strong> failures 
                within <strong className="text-orange-300">{Math.round((det.quarantine_window_sec ?? 300) / 60)} min</strong> will 
                be quarantined for <strong className="text-orange-300">{Math.round((det.quarantine_duration_sec ?? 900) / 60)} min</strong>.
              </div>
            </div>
            
            {/* Manual Pool Blocklist */}
            <div className="mt-4 pt-4 border-t border-gray-600">
              <h4 className="text-sm font-semibold text-white mb-2">Manual Pool Blocklist</h4>
              <p className="text-xs text-gray-400 mb-2">
                Permanently block specific pools (persisted to config). Enter pool IDs separated by commas.
              </p>
              <textarea
                className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1 font-mono text-xs h-16 resize-y"
                placeholder="Pool1Address, Pool2Address, ..."
                value={det.manual_pool_blocklist_csv ?? ''} 
                onChange={e=>set('manual_pool_blocklist_csv', e.target.value)} 
              />
              {det.manual_pool_blocklist_csv && String(det.manual_pool_blocklist_csv).split(',').filter((s: string) => s.trim()).length > 0 && (
                <div className="mt-1 text-xs text-orange-400">
                  {String(det.manual_pool_blocklist_csv).split(',').filter((s: string) => s.trim()).length} pool(s) in blocklist
                </div>
              )}
            </div>
          </div>

          {/* Fixed Trade Size - shown as fallback when dynamic sizing is disabled */}
          <div className={`bg-gray-700 rounded p-4 ${det.dynamic_sizing_enabled ? 'opacity-50' : ''}`}>
            <h3 className="text-lg font-semibold text-white mb-2">
              Fixed Trade Size
              {det.dynamic_sizing_enabled && <span className="text-xs text-gray-400 ml-2">(ignored when dynamic sizing enabled)</span>}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block mb-1 text-gray-300">Execution Size (USD)</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_size_usd ?? 100} 
                  onChange={e=>set('executor_size_usd', Number(e.target.value)||0)} 
                  disabled={det.dynamic_sizing_enabled}
                />
              </div>
            </div>
          </div>

          {/* Jito Tipping Configuration */}
          <div className="bg-gray-700 rounded p-4 border-2 border-orange-500/30">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-white">Jito Tipping</h3>
              <label className="flex items-center gap-2 text-sm">
                <input 
                  type="checkbox" 
                  className="w-4 h-4"
                  checked={det.jito_enabled !== false} 
                  onChange={e=>set('jito_enabled', e.target.checked)} 
                />
                <span className="text-orange-400">Enabled</span>
              </label>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Jito tips improve transaction landing rates by incentivizing validators. Tips are calculated as a share of expected profit.
            </p>
            
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${det.jito_enabled === false ? 'opacity-50' : ''}`}>
              <div>
                <label className="block mb-1 text-gray-300">Tip Mode</label>
                <select 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                  value={det.jito_tip_mode || 'dynamic'}
                  onChange={e=>set('jito_tip_mode', e.target.value)}
                  disabled={det.jito_enabled === false}
                >
                  <option value="dynamic">Dynamic (% of profit)</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </div>
              
              {(det.jito_tip_mode || 'dynamic') === 'dynamic' ? (
                <div>
                  <label className="block mb-1 text-gray-300">
                    Tip Share (% of profit)
                    <span className="text-xs text-gray-500 ml-2">0.35 = 35%</span>
                  </label>
                  <input 
                    type="number" 
                    step="0.05"
                    min="0.05"
                    max="0.90"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.jito_tip_share ?? 0.35} 
                    onChange={e=>set('jito_tip_share', Number(e.target.value)||0.35)} 
                    disabled={det.jito_enabled === false}
                  />
                </div>
              ) : (
                <div>
                  <label className="block mb-1 text-gray-300">
                    Fixed Tip (lamports)
                    <span className="text-xs text-gray-500 ml-2">1M = 0.001 SOL</span>
                  </label>
                  <input 
                    type="number" 
                    step="10000"
                    min="1000"
                    className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                    value={det.jito_fixed_tip_lamports ?? 10000} 
                    onChange={e=>set('jito_fixed_tip_lamports', Number(e.target.value)||10000)} 
                    disabled={det.jito_enabled === false}
                  />
                </div>
              )}
              
              <div>
                <label className="block mb-1 text-gray-300">
                  Min Tip (lamports)
                  <span className="text-xs text-gray-500 ml-2">Floor for all tips</span>
                </label>
                <input 
                  type="number" 
                  step="1000"
                  min="1000"
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.jito_min_tip_lamports ?? 10000} 
                  onChange={e=>set('jito_min_tip_lamports', Number(e.target.value)||10000)} 
                  disabled={det.jito_enabled === false}
                />
              </div>
              
              <div>
                <label className="block mb-1 text-gray-300">
                  Max Tip (lamports)
                  <span className="text-xs text-gray-500 ml-2">Cap for all tips</span>
                </label>
                <input 
                  type="number" 
                  step="100000"
                  min="10000"
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.jito_max_tip_lamports ?? 5000000} 
                  onChange={e=>set('jito_max_tip_lamports', Number(e.target.value)||5000000)} 
                  disabled={det.jito_enabled === false}
                />
              </div>
            </div>

            {/* Tip calculation preview */}
            {det.jito_enabled !== false && (det.jito_tip_mode || 'dynamic') === 'dynamic' && (
              <div className="mt-4 p-3 bg-gray-800/50 rounded text-xs text-gray-400">
                <strong className="text-gray-300">Example tips (for $100 trade):</strong>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                  {[50, 100, 200, 500].map(bps => {
                    const profitPct = bps / 100;
                    const profitUsd = 100 * (bps / 10000);
                    const tipShare = det.jito_tip_share || 0.35;
                    const minTip = det.jito_min_tip_lamports || 10000;
                    const maxTip = det.jito_max_tip_lamports || 5000000;
                    // Assume SOL = $200 for preview
                    const profitLamports = (profitUsd / 200) * 1e9;
                    const rawTip = profitLamports * tipShare;
                    const finalTip = Math.max(minTip, Math.min(maxTip, rawTip));
                    const tipSol = finalTip / 1e9;
                    return (
                      <div key={bps} className="bg-gray-700/50 p-2 rounded">
                        <div className="text-gray-500">{profitPct}% profit</div>
                        <div className="text-orange-400 font-mono">
                          {tipSol >= 0.001 ? `${tipSol.toFixed(4)} SOL` : `${Math.round(finalTip)} lamp`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold text-white mb-3">Execution</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block mb-1 text-gray-300">Mode</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={execMode} onChange={e=>setExecMode(e.target.value as any)}>
                  <option value="simulate">simulate</option>
                  <option value="direct">direct</option>
                </select>
              </div>
              <label className="flex items-center gap-2">
                <input 
                  type="checkbox" 
                  checked={!!det.require_start_balance} 
                  onChange={e=>set('require_start_balance', e.target.checked)} 
                />
                Require wallet balance
              </label>
            </div>
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


