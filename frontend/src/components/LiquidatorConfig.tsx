// @ts-nocheck
import React, { useEffect, useState } from 'react';

interface Props {
  apiBase?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const LiquidatorConfig: React.FC<Props> = ({ apiBase = '/api', onClose, onSaved }) => {
  const [form, setForm] = useState<any>({
    usePriceTriggers: true,
    priceTriggerDebounceMs: 800,
    httpPollMs: 1200,
    maxUsersPerPriceTick: 40,
    discoverAllUsers: true,
    maxDiscoveredUsers: 500,
    riskHealthThreshold: 0,
    marketsAllowlistCsv: '',
    usersAllowlistCsv: '',
    restartOnSave: false,
    // New staged-probe options
    accountLoaderMs: 1000,
    maxProbesPerTick: 40,
    probeMarketIndicesCsv: '',
    positionMinAbsBase: 0,
    positionMaxAbsBase: '',
    idleCooldownMs: 60000,
    outOfScopeCooldownMs: 60000,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`${apiBase}/strategies/liquidator/config`);
        const data = await res.json();
        if (!alive) return;
        const cfg = (data?.config || {}) as any;
        const markets = Array.isArray(data?.marketsAllowlist) ? data.marketsAllowlist : [];
        setForm((prev: any) => ({
          ...prev,
          usePriceTriggers: cfg.usePriceTriggers !== false,
          priceTriggerDebounceMs: Number(cfg.priceTriggerDebounceMs ?? prev.priceTriggerDebounceMs),
          httpPollMs: Number(cfg.httpPollMs ?? prev.httpPollMs),
          maxUsersPerPriceTick: Number(cfg.maxUsersPerPriceTick ?? prev.maxUsersPerPriceTick),
          discoverAllUsers: cfg.discoverAllUsers !== false,
          maxDiscoveredUsers: Number(cfg.maxDiscoveredUsers ?? prev.maxDiscoveredUsers),
          riskHealthThreshold: Number(cfg.riskHealthThreshold ?? prev.riskHealthThreshold),
          marketsAllowlistCsv: Array.isArray(markets) ? markets.join(',') : '',
          usersAllowlistCsv: Array.isArray(cfg.usersAllowlist) ? (cfg.usersAllowlist as any[]).join(',') : '',
          accountLoaderMs: Number(cfg.accountLoaderMs ?? prev.accountLoaderMs),
          maxProbesPerTick: Number(cfg.maxProbesPerTick ?? prev.maxProbesPerTick),
          probeMarketIndicesCsv: Array.isArray(cfg.probeMarketIndices) ? (cfg.probeMarketIndices as any[]).join(',') : '',
          positionMinAbsBase: Number(cfg.positionMinAbsBase ?? prev.positionMinAbsBase),
          positionMaxAbsBase: (cfg.positionMaxAbsBase ?? prev.positionMaxAbsBase),
          idleCooldownMs: Number(cfg.idleCooldownMs ?? prev.idleCooldownMs),
          outOfScopeCooldownMs: Number(cfg.outOfScopeCooldownMs ?? prev.outOfScopeCooldownMs),
        }));
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [apiBase]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const body: any = {
        usePriceTriggers: !!form.usePriceTriggers,
        priceTriggerDebounceMs: Math.max(200, Number(form.priceTriggerDebounceMs || 0)),
        httpPollMs: Math.max(200, Number(form.httpPollMs || 0)),
        maxUsersPerPriceTick: Math.max(1, Number(form.maxUsersPerPriceTick || 1)),
        discoverAllUsers: !!form.discoverAllUsers,
        maxDiscoveredUsers: Math.max(1, Number(form.maxDiscoveredUsers || 1)),
        riskHealthThreshold: Number(form.riskHealthThreshold || 0),
        usersAllowlist: String(form.usersAllowlistCsv || '').split(',').map((s) => s.trim()).filter(Boolean),
        marketsAllowlist: String(form.marketsAllowlistCsv || '').split(',').map((s) => s.trim()).filter(Boolean),
        accountLoaderMs: Math.max(200, Number(form.accountLoaderMs || 0)),
        maxProbesPerTick: Math.max(1, Number(form.maxProbesPerTick || 1)),
        probeMarketIndices: String(form.probeMarketIndicesCsv || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
        positionMinAbsBase: Math.max(0, Number(form.positionMinAbsBase || 0)),
        positionMaxAbsBase: String(form.positionMaxAbsBase ?? '').trim() === '' ? undefined : Math.max(0, Number(form.positionMaxAbsBase)),
        idleCooldownMs: Math.max(1000, Number(form.idleCooldownMs || 0)),
        outOfScopeCooldownMs: Math.max(1000, Number(form.outOfScopeCooldownMs || 0)),
        restart: !!form.restartOnSave,
      };
      const res = await fetch(`${apiBase}/strategies/liquidator/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
          <h2 className="text-2xl font-bold text-white">Liquidator Config</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.usePriceTriggers} onChange={(e) => setForm((p: any) => ({ ...p, usePriceTriggers: e.target.checked }))} />
            <span className="text-gray-300">Enable Price Triggers</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Price Trigger Debounce (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.priceTriggerDebounceMs}
              onChange={(e) => setForm((p: any) => ({ ...p, priceTriggerDebounceMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">HTTP Poll Interval (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.httpPollMs}
              onChange={(e) => setForm((p: any) => ({ ...p, httpPollMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Max Users Per Price Tick</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxUsersPerPriceTick}
              onChange={(e) => setForm((p: any) => ({ ...p, maxUsersPerPriceTick: Number(e.target.value) }))} />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.discoverAllUsers} onChange={(e) => setForm((p: any) => ({ ...p, discoverAllUsers: e.target.checked }))} />
            <span className="text-gray-300">Discover All Users</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Max Discovered Users</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxDiscoveredUsers}
              onChange={(e) => setForm((p: any) => ({ ...p, maxDiscoveredUsers: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Risk Health Threshold</div>
            <input type="number" step={0.01} className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.riskHealthThreshold}
              onChange={(e) => setForm((p: any) => ({ ...p, riskHealthThreshold: Number(e.target.value) }))} />
          </div>
          <div className="md:col-span-3">
            <div className="text-gray-400 mb-1">Markets Allowlist (CSV)</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" placeholder="0:SOL-PERP,1:BTC-PERP,2:ETH-PERP"
              value={form.marketsAllowlistCsv} onChange={(e) => setForm((p: any) => ({ ...p, marketsAllowlistCsv: e.target.value }))} />
          </div>
          <div className="md:col-span-3">
            <div className="text-gray-400 mb-1">Users Allowlist (CSV of base58)</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" placeholder="User PKs…"
              value={form.usersAllowlistCsv} onChange={(e) => setForm((p: any) => ({ ...p, usersAllowlistCsv: e.target.value }))} />
          </div>
          <div className="md:col-span-3 border-t border-gray-700 pt-3 font-semibold text-gray-200">Probing & Filters</div>
          <div>
            <div className="text-gray-400 mb-1">Account Loader Interval (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.accountLoaderMs}
              onChange={(e) => setForm((p: any) => ({ ...p, accountLoaderMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Max Probes per Tick</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxProbesPerTick}
              onChange={(e) => setForm((p: any) => ({ ...p, maxProbesPerTick: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Probe Market Indices (CSV)</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" placeholder="0,1,2" value={form.probeMarketIndicesCsv}
              onChange={(e) => setForm((p: any) => ({ ...p, probeMarketIndicesCsv: e.target.value }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Min |Base| to Consider Active</div>
            <input type="number" step={0.0001} className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.positionMinAbsBase}
              onChange={(e) => setForm((p: any) => ({ ...p, positionMinAbsBase: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Max |Base| (optional)</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.positionMaxAbsBase}
              onChange={(e) => setForm((p: any) => ({ ...p, positionMaxAbsBase: e.target.value }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Idle Cooldown (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.idleCooldownMs}
              onChange={(e) => setForm((p: any) => ({ ...p, idleCooldownMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Out-of-Scope Cooldown (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.outOfScopeCooldownMs}
              onChange={(e) => setForm((p: any) => ({ ...p, outOfScopeCooldownMs: Number(e.target.value) }))} />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.restartOnSave} onChange={(e) => setForm((p: any) => ({ ...p, restartOnSave: e.target.checked }))} />
            <span className="text-gray-300">Restart Liquidators on Save</span>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button disabled={saving || loading} onClick={onClose} className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-60">Cancel</button>
          <button disabled={saving || loading} onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
};

export default LiquidatorConfig;


