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
      try { const r = await fetch(`${apiBase}${ROUTES.arb.config}`); if (r.ok) setDet(await r.json()); } catch {}
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
      anchor_start_mode: !!det.anchor_start_mode,
      filtered_node_ratio: toOptNum(det.filtered_node_ratio),
      filtered_expand_hops: toOptNum(det.filtered_expand_hops),
      periodic_full_ms: toOptNum(det.periodic_full_ms),
      // path pruning
      max_sol_stable_hops: toOptNum(det.max_sol_stable_hops),
      drop_stable_stable_hops: !!det.drop_stable_stable_hops,
      stable_mints: String(det.stable_mints_csv || '')
        .split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      const [r1, r2, r3] = await Promise.all([
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
          }) 
        }),
      ]);
      if (!r1.ok || !r2.ok || !r3.ok) throw new Error('Failed to save');
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
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!det.anchor_start_mode} onChange={e=>set('anchor_start_mode', e.target.checked)} />Start cycles from anchors only</label>
              <div><label className="block mb-1 text-gray-300">Node ratio</label><input type="number" step={0.01} className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.filtered_node_ratio ?? ''} onChange={e=>set('filtered_node_ratio', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Expand hops</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.filtered_expand_hops ?? ''} onChange={e=>set('filtered_expand_hops', Number(e.target.value)||0)} /></div>
              <div><label className="block mb-1 text-gray-300">Periodic full (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={det.periodic_full_ms ?? ''} onChange={e=>set('periodic_full_ms', Number(e.target.value)||0)} /></div>
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
                <label className="block mb-1 text-gray-300">Execution Size (USD)</label>
                <input 
                  type="number" 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={det.executor_size_usd ?? 100} 
                  onChange={e=>set('executor_size_usd', Number(e.target.value)||0)} 
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


