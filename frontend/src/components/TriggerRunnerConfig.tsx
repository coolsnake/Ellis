// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { ROUTES } from '../utils/routes';

interface Props {
  apiBase?: string;
  onClose: () => void;
  onSaved?: () => void;
  initialConfig?: any;
}

export const TriggerRunnerConfig: React.FC<Props> = ({ apiBase = '/api', onClose, onSaved, initialConfig }) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ markets: Array<{ marketIndex: number; symbol?: string }> } | null>(null);
  const [form, setForm] = useState<any>({
    name: initialConfig?.name || 'trigger-bot',
    dryRun: initialConfig?.dryRun ?? true,
    intervalMs: initialConfig?.intervalMs ?? 1000,
    triggerPriorityFeeMultiplier: initialConfig?.triggerPriorityFeeMultiplier ?? 1.0,
    priorityFeeAddressesCsv: Array.isArray(initialConfig?.priorityFeeAddresses) ? initialConfig.priorityFeeAddresses.join(',') : '',
    updateOracleWithTrigger: initialConfig?.updateOracleWithTrigger ?? false,
    oracleSource: initialConfig?.oracleSource || 'auto',
    selectedMarketIndices: Array.isArray(initialConfig?.marketIndices) ? (initialConfig.marketIndices as any[]) : [],
    triggerCooldownMs: initialConfig?.triggerCooldownMs ?? 10000,
    metricsPort: initialConfig?.metricsPort ?? '',
    logDetail: initialConfig?.logDetail || 'basic',
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${apiBase}${ROUTES.drift.status}`);
        const data = await res.json();
        if (!alive) return;
        const markets = Array.isArray(data?.markets) ? data.markets : [];
        setStatus({ markets });
      } catch {}
    })();
    return () => { alive = false; };
  }, [apiBase]);

  const markets = useMemo(() => status?.markets || [], [status]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const trimmed = String(form.name || '').trim();
      if (!trimmed) throw new Error('Name is required');
      const body: any = {
        botId: trimmed,
        dryRun: !!form.dryRun,
        intervalMs: Math.max(200, Number(form.intervalMs || 0)),
        triggerPriorityFeeMultiplier: Math.max(0, Number(form.triggerPriorityFeeMultiplier || 0)),
        priorityFeeAddresses: String(form.priorityFeeAddressesCsv || '').split(',').map((s) => s.trim()).filter(Boolean),
        updateOracleWithTrigger: !!form.updateOracleWithTrigger,
        oracleSource: String(form.oracleSource || 'auto'),
        marketIndices: (Array.isArray(form.selectedMarketIndices) ? form.selectedMarketIndices : []).map((n: any) => Number(n)).filter((n) => Number.isFinite(n)),
        triggerCooldownMs: Math.max(1000, Number(form.triggerCooldownMs || 0)),
        metricsPort: String(form.metricsPort ?? '').trim() === '' ? undefined : Math.max(1024, Number(form.metricsPort)),
        logDetail: String(form.logDetail || 'basic'),
      };
      const res = await fetch(`${apiBase}${ROUTES.drift.triggerStart}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      try { onSaved && onSaved(); } catch {}
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">New Trigger</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-400 mb-1">Name<span className="text-red-400"> *</span></div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.name} onChange={(e) => setForm((p: any) => ({ ...p, name: e.target.value }))} placeholder="e.g., trigger-sol-perp" />
          </div>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="h-4 w-4" checked={!!form.dryRun} onChange={(e) => setForm((p: any) => ({ ...p, dryRun: e.target.checked }))} />
            <span className="text-gray-300">Dry Run</span>
          </label>

          <div>
            <div className="text-gray-400 mb-1">Interval (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.intervalMs} onChange={(e) => setForm((p: any) => ({ ...p, intervalMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Priority Fee Multiplier</div>
            <input type="number" step={0.01} className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.triggerPriorityFeeMultiplier} onChange={(e) => setForm((p: any) => ({ ...p, triggerPriorityFeeMultiplier: Number(e.target.value) }))} />
          </div>
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Priority Fee Addresses (CSV)</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.priorityFeeAddressesCsv} onChange={(e) => setForm((p: any) => ({ ...p, priorityFeeAddressesCsv: e.target.value }))} placeholder="<address1>,<address2>" />
          </div>

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Oracle & Markets</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.updateOracleWithTrigger} onChange={(e) => setForm((p: any) => ({ ...p, updateOracleWithTrigger: e.target.checked }))} />
            <span className="text-gray-300">Update Oracle With Trigger</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Oracle Source</div>
            <select className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.oracleSource} onChange={(e) => setForm((p: any) => ({ ...p, oracleSource: e.target.value }))}>
              <option value="auto">auto</option>
              <option value="lazer">lazer</option>
              <option value="pull">pull</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Markets to Track</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-auto p-2 bg-gray-700 rounded">
              {(markets || []).map((m) => {
                const idx = Number(m.marketIndex);
                const sym = m.symbol || `PERP-${idx}`;
                const selected = Array.isArray(form.selectedMarketIndices) && form.selectedMarketIndices.includes(idx);
                return (
                  <label key={`m-${idx}`} className={`flex items-center gap-2 text-sm ${selected ? 'text-white' : 'text-gray-300'}`}>
                    <input
                      type="checkbox"
                      checked={!!selected}
                      onChange={(e) => {
                        setForm((p: any) => {
                          const set = new Set<number>(Array.isArray(p.selectedMarketIndices) ? p.selectedMarketIndices : []);
                          if (e.target.checked) set.add(idx); else set.delete(idx);
                          return { ...p, selectedMarketIndices: Array.from(set) };
                        });
                      }}
                    />
                    <span>{sym} ({idx})</span>
                  </label>
                );
              })}
              {(markets || []).length === 0 && (
                <div className="text-gray-300 text-xs col-span-2">No markets found. Ensure Drift status is available.</div>
              )}
            </div>
          </div>

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Advanced</div>
          <div>
            <div className="text-gray-400 mb-1">Cooldown (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.triggerCooldownMs} onChange={(e) => setForm((p: any) => ({ ...p, triggerCooldownMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Metrics Port (optional)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.metricsPort} onChange={(e) => setForm((p: any) => ({ ...p, metricsPort: e.target.value }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Log Detail</div>
            <select className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.logDetail} onChange={(e) => setForm((p: any) => ({ ...p, logDetail: e.target.value }))}>
              <option value="basic">basic</option>
              <option value="verbose">verbose</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button disabled={saving} onClick={onClose} className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-60">Cancel</button>
          <button disabled={saving || !String(form.name||'').trim()} onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save & Start'}</button>
        </div>
      </div>
    </div>
  );
};

export default TriggerRunnerConfig;


