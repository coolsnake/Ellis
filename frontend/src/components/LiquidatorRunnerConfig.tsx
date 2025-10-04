// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';

interface Props {
  apiBase?: string;
  onClose: () => void;
  onSaved?: () => void;
  initialConfig?: any;
}

export const LiquidatorRunnerConfig: React.FC<Props> = ({ apiBase = '/api', onClose, onSaved, initialConfig }) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ markets: Array<{ marketIndex: number; symbol?: string }> } | null>(null);
  const [form, setForm] = useState<any>({
    name: initialConfig?.name || '',
    dryRun: initialConfig?.dryRun ?? true,
    pollMs: initialConfig?.pollMs ?? 1500,
    maxConcurrentTargets: initialConfig?.maxConcurrentTargets ?? 2,

    // Discovery & scanning
    discoverAllUsers: initialConfig?.discoverAllUsers ?? true,
    maxDiscoveredUsers: initialConfig?.maxDiscoveredUsers ?? 500,
    usersAllowlistCsv: Array.isArray(initialConfig?.usersAllowlist) ? initialConfig.usersAllowlist.join(',') : '',
    scanConcurrency: initialConfig?.scanConcurrency ?? 10,
    userCacheMax: initialConfig?.userCacheMax ?? 500,
    riskHealthThreshold: initialConfig?.riskHealthThreshold ?? 0,

    // Triggers & markets
    usePriceTriggers: initialConfig?.usePriceTriggers ?? true,
    priceTriggerDebounceMs: initialConfig?.priceTriggerDebounceMs ?? 800,
    httpPollMs: initialConfig?.httpPollMs ?? 1200,
    maxUsersPerPriceTick: initialConfig?.maxUsersPerPriceTick ?? 40,
    selectedMarketIndices: Array.isArray(initialConfig?.marketIndices) ? (initialConfig.marketIndices as any[]) : [],

    // Execution tuning
    maxCancels: initialConfig?.maxCancels ?? 20,
    maxPerpAttempts: initialConfig?.maxPerpAttempts ?? 3,
    perpSizeFraction: initialConfig?.perpSizeFraction ?? 0.05,
    maxSpotAttempts: initialConfig?.maxSpotAttempts ?? 2,
    spotSizeFraction: initialConfig?.spotSizeFraction ?? 0.05,
    targetCooldownMs: initialConfig?.targetCooldownMs ?? 7000,
    statsIntervalMs: initialConfig?.statsIntervalMs ?? 15000,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/drift/status`);
        const data = await res.json();
        if (!alive) return;
        setStatus({ markets: Array.isArray(data?.markets) ? data.markets : [] });
      } catch {}
    })();
    return () => { alive = false; };
  }, [apiBase]);

  const markets = useMemo(() => status?.markets || [], [status]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const body: any = {
        name: String(form.name || 'default').trim() || 'default',
        dryRun: !!form.dryRun,
        pollMs: Math.max(200, Number(form.pollMs || 0)),
        maxConcurrentTargets: Math.max(1, Number(form.maxConcurrentTargets || 1)),

        discoverAllUsers: !!form.discoverAllUsers,
        maxDiscoveredUsers: Math.max(1, Number(form.maxDiscoveredUsers || 1)),
        usersAllowlist: String(form.usersAllowlistCsv || '').split(',').map((s) => s.trim()).filter(Boolean),
        scanConcurrency: Math.max(1, Number(form.scanConcurrency || 1)),
        userCacheMax: Math.max(50, Number(form.userCacheMax || 50)),
        riskHealthThreshold: Number(form.riskHealthThreshold || 0),

        usePriceTriggers: !!form.usePriceTriggers,
        priceTriggerDebounceMs: Math.max(200, Number(form.priceTriggerDebounceMs || 0)),
        httpPollMs: Math.max(200, Number(form.httpPollMs || 0)),
        maxUsersPerPriceTick: Math.max(1, Number(form.maxUsersPerPriceTick || 1)),
        marketIndices: (Array.isArray(form.selectedMarketIndices) ? form.selectedMarketIndices : []).map((n: any) => Number(n)).filter((n) => Number.isFinite(n)),

        maxCancels: Math.max(1, Number(form.maxCancels || 1)),
        maxPerpAttempts: Math.max(1, Number(form.maxPerpAttempts || 1)),
        perpSizeFraction: Math.max(0.001, Math.min(0.5, Number(form.perpSizeFraction || 0))),
        maxSpotAttempts: Math.max(1, Number(form.maxSpotAttempts || 1)),
        spotSizeFraction: Math.max(0.001, Math.min(0.5, Number(form.spotSizeFraction || 0))),
        targetCooldownMs: Math.max(500, Number(form.targetCooldownMs || 0)),
        statsIntervalMs: Math.max(1000, Number(form.statsIntervalMs || 0)),
      };
      const res = await fetch(`${apiBase}/strategies/liquidator/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">New Liquidator</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-400 mb-1">Name</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.name} onChange={(e) => setForm((p: any) => ({ ...p, name: e.target.value }))} />
          </div>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="h-4 w-4" checked={!!form.dryRun} onChange={(e) => setForm((p: any) => ({ ...p, dryRun: e.target.checked }))} />
            <span className="text-gray-300">Dry Run</span>
          </label>

          <div>
            <div className="text-gray-400 mb-1">Poll Interval (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.pollMs} onChange={(e) => setForm((p: any) => ({ ...p, pollMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Max Concurrent Targets</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxConcurrentTargets} onChange={(e) => setForm((p: any) => ({ ...p, maxConcurrentTargets: Number(e.target.value) }))} />
          </div>

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Discovery & Scanning</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.discoverAllUsers} onChange={(e) => setForm((p: any) => ({ ...p, discoverAllUsers: e.target.checked }))} />
            <span className="text-gray-300">Discover All Users</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Max Discovered Users</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxDiscoveredUsers} onChange={(e) => setForm((p: any) => ({ ...p, maxDiscoveredUsers: Number(e.target.value) }))} />
          </div>
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Users Allowlist (CSV base58)</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.usersAllowlistCsv} onChange={(e) => setForm((p: any) => ({ ...p, usersAllowlistCsv: e.target.value }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Scan Concurrency</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.scanConcurrency} onChange={(e) => setForm((p: any) => ({ ...p, scanConcurrency: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">User Cache Max</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.userCacheMax} onChange={(e) => setForm((p: any) => ({ ...p, userCacheMax: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Risk Health Threshold</div>
            <input type="number" step={0.01} className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.riskHealthThreshold} onChange={(e) => setForm((p: any) => ({ ...p, riskHealthThreshold: Number(e.target.value) }))} />
          </div>

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Price Triggers & Markets</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.usePriceTriggers} onChange={(e) => setForm((p: any) => ({ ...p, usePriceTriggers: e.target.checked }))} />
            <span className="text-gray-300">Enable Price Triggers</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Trigger Debounce (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.priceTriggerDebounceMs} onChange={(e) => setForm((p: any) => ({ ...p, priceTriggerDebounceMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">HTTP Poll (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.httpPollMs} onChange={(e) => setForm((p: any) => ({ ...p, httpPollMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Max Users per Price Tick</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxUsersPerPriceTick} onChange={(e) => setForm((p: any) => ({ ...p, maxUsersPerPriceTick: Number(e.target.value) }))} />
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

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Execution Tuning</div>
          <div>
            <div className="text-gray-400 mb-1">Max Cancels</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxCancels} onChange={(e) => setForm((p: any) => ({ ...p, maxCancels: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Perp Attempts</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxPerpAttempts} onChange={(e) => setForm((p: any) => ({ ...p, maxPerpAttempts: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Perp Size Fraction</div>
            <input type="number" step={0.001} className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.perpSizeFraction} onChange={(e) => setForm((p: any) => ({ ...p, perpSizeFraction: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Spot Attempts</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxSpotAttempts} onChange={(e) => setForm((p: any) => ({ ...p, maxSpotAttempts: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Spot Size Fraction</div>
            <input type="number" step={0.001} className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.spotSizeFraction} onChange={(e) => setForm((p: any) => ({ ...p, spotSizeFraction: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Target Cooldown (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.targetCooldownMs} onChange={(e) => setForm((p: any) => ({ ...p, targetCooldownMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Stats Interval (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.statsIntervalMs} onChange={(e) => setForm((p: any) => ({ ...p, statsIntervalMs: Number(e.target.value) }))} />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button disabled={saving} onClick={onClose} className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-60">Cancel</button>
          <button disabled={saving} onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save & Start'}</button>
        </div>
      </div>
    </div>
  );
};

export default LiquidatorRunnerConfig;


