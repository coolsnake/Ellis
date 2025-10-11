import React, { useState } from 'react';
import { ROUTES } from '../utils/routes';

// Deprecated: Prefer OpportunityConfig for detector tuning and ArbEngineConfig for execution.
// This modal now only exposes a minimal subset for backward compatibility.

type ArbConfigProps = {
  apiBase: string;
  initial?: Partial<ArbConfigState>;
  onClose: () => void;
};

// Minimal surface retained

type ArbConfigState = {
  enabled: boolean;
  minProfitBps: number;
  minNotionalUsd: number;
  maxHops: number;
  quoteSizeUsd: number;
  debugEmitSubthreshold?: boolean;
  debugTopN?: number;
  nearMissEnable?: boolean;
  nearMissEpsilon?: number;
};

export const ArbConfig: React.FC<ArbConfigProps> = ({ apiBase, initial, onClose }) => {
  const [cfg, setCfg] = useState<ArbConfigState>({
    enabled: initial?.enabled ?? true,
    minProfitBps: (initial as any)?.minProfitBps ?? (initial as any)?.min_profit_bps ?? 0,
    minNotionalUsd: (initial as any)?.minNotionalUsd ?? (initial as any)?.min_notional_usd ?? 0,
    maxHops: (initial as any)?.maxHops ?? (initial as any)?.max_hops ?? 0,
    quoteSizeUsd: (initial as any)?.quoteSizeUsd ?? (initial as any)?.quote_size_usd ?? 0,
    debugEmitSubthreshold: (initial as any)?.debugEmitSubthreshold ?? (initial as any)?.debug_emit_subthreshold ?? false,
    debugTopN: (initial as any)?.debugTopN ?? (initial as any)?.debug_top_n ?? 5,
    nearMissEnable: (initial as any)?.nearMissEnable ?? (initial as any)?.near_miss_enable ?? true,
    nearMissEpsilon: (initial as any)?.nearMissEpsilon ?? (initial as any)?.near_miss_epsilon ?? 0.0005,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const set = (k: keyof ArbConfigState, v: any) => setCfg(prev => ({ ...prev, [k]: v }));

  React.useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}${ROUTES.arb.config}`);
        if (r.ok) {
          const j = await r.json();
          setCfg(prev => ({
            ...prev,
            enabled: j.enabled ?? prev.enabled,
            minProfitBps: j.min_profit_bps ?? prev.minProfitBps,
            minNotionalUsd: j.min_notional_usd ?? prev.minNotionalUsd,
            maxHops: j.max_hops ?? prev.maxHops,
            quoteSizeUsd: j.quote_size_usd ?? prev.quoteSizeUsd,
            debugEmitSubthreshold: typeof j.debug_emit_subthreshold === 'boolean' ? j.debug_emit_subthreshold : (prev.debugEmitSubthreshold ?? false),
            debugTopN: typeof j.debug_top_n === 'number' ? j.debug_top_n : (prev.debugTopN ?? 5),
            nearMissEnable: typeof j.near_miss_enable === 'boolean' ? j.near_miss_enable : (prev.nearMissEnable ?? true),
            nearMissEpsilon: typeof j.near_miss_epsilon === 'number' ? j.near_miss_epsilon : (prev.nearMissEpsilon ?? 0.0005),
          }));
        }
      } catch {}
    })();
  }, [apiBase]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const body = {
      enabled: cfg.enabled,
      min_profit_bps: cfg.minProfitBps,
      min_notional_usd: cfg.minNotionalUsd,
      max_hops: cfg.maxHops,
      quote_size_usd: cfg.quoteSizeUsd,
      debug_emit_subthreshold: !!cfg.debugEmitSubthreshold,
      debug_top_n: typeof cfg.debugTopN === 'number' ? cfg.debugTopN : 5,
      near_miss_enable: !!cfg.nearMissEnable,
      near_miss_epsilon: typeof cfg.nearMissEpsilon === 'number' ? cfg.nearMissEpsilon : 0.0005,
    };
    try {
      const r = await fetch(`${apiBase}${ROUTES.arb.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Failed to save');
      onClose();
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Arbitrage Configuration (Deprecated)</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {saveError && <div className="mb-2 text-sm text-red-400">{saveError}</div>}
        <div className="text-xs text-yellow-300 mb-3">Use Opportunity Config for full detector controls.</div>
        <div className="space-y-6">
          <div className="flex items-center space-x-3">
            <input id="arb-enabled" type="checkbox" className="w-4 h-4" checked={cfg.enabled} onChange={e => set('enabled', e.target.checked)} />
            <label htmlFor="arb-enabled" className="text-sm text-gray-300">Enable arbitrage detection</label>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-600">
            <h3 className="text-lg font-semibold text-white mb-3">Detection Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Minimum Profit (bps)</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.minProfitBps} onChange={e=>set('minProfitBps', parseInt(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Min Notional (USD)</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.minNotionalUsd} onChange={e=>set('minNotionalUsd', parseFloat(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Max Hops</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.maxHops} onChange={e=>set('maxHops', parseInt(e.target.value)||3)} />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Quote Size (USD)</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.quoteSizeUsd} onChange={e=>set('quoteSizeUsd', parseFloat(e.target.value)||50)} />
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-gray-600">
            <h3 className="text-lg font-semibold text-white mb-3">Near-miss & Debug</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center space-x-3">
                <input id="near-miss-enable" type="checkbox" className="w-4 h-4" checked={!!cfg.nearMissEnable} onChange={e=>set('nearMissEnable', e.target.checked)} />
                <label htmlFor="near-miss-enable" className="text-sm text-gray-300">Enable near-miss</label>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Near-miss epsilon</label>
                <input type="number" step={0.0001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.nearMissEpsilon ?? 0.0005} onChange={e=>set('nearMissEpsilon', parseFloat(e.target.value)||0.0005)} />
              </div>
              <div className="flex items-center space-x-3">
                <input id="dbg-subth" type="checkbox" className="w-4 h-4" checked={!!cfg.debugEmitSubthreshold} onChange={e=>set('debugEmitSubthreshold', e.target.checked)} />
                <label htmlFor="dbg-subth" className="text-sm text-gray-300">Emit sub-threshold</label>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Debug Top-N</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.debugTopN ?? 5} onChange={e=>set('debugTopN', parseInt(e.target.value)||5)} />
              </div>
            </div>
          </div>

          <div className="flex justify-end space-x-3 pt-4 border-t border-gray-600">
            <button className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700" onClick={onClose} disabled={saving}>Cancel</button>
            <button className={`px-4 py-2 ${saving?'bg-blue-500/60':'bg-blue-600 hover:bg-blue-700'} text-white rounded-md`} onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};


