// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { ROUTES } from '../utils/routes';

interface Props {
  apiBase?: string;
  onClose: () => void;
  onSaved?: () => void;
  initialConfig?: any;
}

export const FillerRunnerConfig: React.FC<Props> = ({ apiBase = '/api', onClose, onSaved, initialConfig }) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ markets: Array<{ marketIndex: number; symbol?: string }>; subaccounts?: Array<{ id: number }> } | null>(null);
  const [form, setForm] = useState<any>({
    name: initialConfig?.name || '',
    dryRun: initialConfig?.dryRun ?? true,
    intervalMs: initialConfig?.intervalMs ?? 1200,
    cuLimit: initialConfig?.cuLimit ?? 1000000,
    priorityFeeMicroLamports: initialConfig?.priorityFeeMicroLamports ?? 0,
    subaccountId: initialConfig?.subaccountId ?? '',
    selectedMarketIndices: Array.isArray(initialConfig?.marketsAllowlist) ? (initialConfig.marketsAllowlist as any[]) : [],
    marketsAllowlistCsv: Array.isArray(initialConfig?.marketsAllowlist) ? (initialConfig.marketsAllowlist as any[]).join(',') : '',
    maxMakersPerFill: initialConfig?.maxMakersPerFill ?? 2,
    allowAmmFills: initialConfig?.allowAmmFills ?? true,
    // NEW heuristics
    skipYoungOrderMs: initialConfig?.skipYoungOrderMs ?? 0,
    requireExistingMakers: initialConfig?.requireExistingMakers ?? true,
    minMakerCountPerNode: initialConfig?.minMakerCountPerNode ?? 1,
    denyJitTakersTtlMs: initialConfig?.denyJitTakersTtlMs ?? 15000,
    minTipFloorToAttemptLamports: initialConfig?.minTipFloorToAttemptLamports ?? 0,
    // Profitability / sizing gates
    minNotionalQuote: initialConfig?.minNotionalQuote ?? 0,
    minRemainingBase: initialConfig?.minRemainingBase ?? 0,
    rewardShare: initialConfig?.rewardShare ?? 0.5,
    minRewardQuote: initialConfig?.minRewardQuote ?? 0,
    minProfitQuote: initialConfig?.minProfitQuote ?? 0,
    minRewardToCostRatio: initialConfig?.minRewardToCostRatio ?? 0,
    maxCandidatesPerLoop: initialConfig?.maxCandidatesPerLoop ?? 0,
    rankBy: initialConfig?.rankBy ?? 'profit',
    // Prebuild controls
    prebuildEnabled: initialConfig?.prebuildEnabled ?? true,
    prebuildDistanceBps: initialConfig?.prebuildDistanceBps ?? 10,
    prebuildTtlMs: initialConfig?.prebuildTtlMs ?? 1500,
    prebuildMaxCandidates: initialConfig?.prebuildMaxCandidates ?? 50,
    prebuildMaxInFlight: initialConfig?.prebuildMaxInFlight ?? 2,
    prebuildPerLoop: initialConfig?.prebuildPerLoop ?? 2,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${apiBase}${ROUTES.drift.status}`);
        const data = await res.json();
        if (!alive) return;
        const markets = Array.isArray(data?.markets) ? data.markets : [];
        const subs = Array.isArray(data?.subaccounts) ? data.subaccounts : [];
        setStatus({ markets, subaccounts: subs });
        try {
          if ((form.subaccountId === '' || form.subaccountId === undefined || form.subaccountId === null) && subs.length > 0) {
            setForm((p: any) => ({ ...p, subaccountId: Number(subs[0]?.id ?? 0) }));
          }
        } catch {}
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
      const allowlist = Array.isArray(form.selectedMarketIndices) && form.selectedMarketIndices.length
        ? (form.selectedMarketIndices as any[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : (String(form.marketsAllowlistCsv || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)));
      const body: any = {
        name: trimmed,
        dryRun: !!form.dryRun,
        subaccountId: String(form.subaccountId ?? '').trim() === '' ? undefined : Math.max(0, Number(form.subaccountId)),
        intervalMs: Math.max(300, Number(form.intervalMs || 0)),
        cuLimit: Math.max(100_000, Number(form.cuLimit || 0)),
        priorityFeeMicroLamports: Math.max(0, Number(form.priorityFeeMicroLamports || 0)),
        marketsAllowlist: allowlist,
        maxMakersPerFill: Math.max(0, Number(form.maxMakersPerFill || 0)),
        allowAmmFills: !!form.allowAmmFills,
        // NEW heuristics
        skipYoungOrderMs: Math.max(0, Number(form.skipYoungOrderMs || 0)),
        requireExistingMakers: !!form.requireExistingMakers,
        minMakerCountPerNode: Math.max(0, Number(form.minMakerCountPerNode || 0)),
        denyJitTakersTtlMs: Math.max(0, Number(form.denyJitTakersTtlMs || 0)),
        minTipFloorToAttemptLamports: Math.max(0, Number(form.minTipFloorToAttemptLamports || 0)),
        // Profitability / sizing gates
        minNotionalQuote: Math.max(0, Number(form.minNotionalQuote || 0)),
        minRemainingBase: Math.max(0, Number(form.minRemainingBase || 0)),
        rewardShare: Math.max(0, Math.min(1, Number(form.rewardShare ?? 0.5))),
        minRewardQuote: Math.max(0, Number(form.minRewardQuote || 0)),
        minProfitQuote: Math.max(0, Number(form.minProfitQuote || 0)),
        minRewardToCostRatio: Math.max(0, Number(form.minRewardToCostRatio || 0)),
        maxCandidatesPerLoop: Math.max(0, Number(form.maxCandidatesPerLoop || 0)),
        rankBy: String(form.rankBy || 'profit'),
        // Prebuild controls
        prebuildEnabled: !!form.prebuildEnabled,
        prebuildDistanceBps: Math.max(0, Number(form.prebuildDistanceBps || 0)),
        prebuildTtlMs: Math.max(0, Number(form.prebuildTtlMs || 0)),
        prebuildMaxCandidates: Math.max(0, Number(form.prebuildMaxCandidates || 0)),
        prebuildMaxInFlight: Math.max(0, Number(form.prebuildMaxInFlight || 0)),
        prebuildPerLoop: Math.max(0, Number(form.prebuildPerLoop || 0)),
      };
      const res = await fetch(`${apiBase}${ROUTES.strategies.filler.start}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
          <h2 className="text-2xl font-bold text-white">New Filler Bot</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-400 mb-1">Name<span className="text-red-400"> *</span></div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.name} onChange={(e) => setForm((p: any) => ({ ...p, name: e.target.value }))} placeholder="e.g., fil-default" />
          </div>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="h-4 w-4" checked={!!form.dryRun} onChange={(e) => setForm((p: any) => ({ ...p, dryRun: e.target.checked }))} />
            <span className="text-gray-300">Dry Run</span>
          </label>

          <div>
            <div className="text-gray-400 mb-1">Loop Interval (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.intervalMs} onChange={(e) => setForm((p: any) => ({ ...p, intervalMs: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Compute Unit Limit</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.cuLimit} onChange={(e) => setForm((p: any) => ({ ...p, cuLimit: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Priority Fee (µ-lamports)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.priorityFeeMicroLamports} onChange={(e) => setForm((p: any) => ({ ...p, priorityFeeMicroLamports: Number(e.target.value) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Subaccount</div>
            {Array.isArray(status?.subaccounts) && status?.subaccounts?.length ? (
              <select className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={String(form.subaccountId ?? '')}
                onChange={(e) => setForm((p: any) => ({ ...p, subaccountId: Number(e.target.value) }))}>
                {status!.subaccounts!.map((s) => (
                  <option key={`sub-${s.id}`} value={String(s.id)}>
                    {`Subaccount ${s.id}`}
                  </option>
                ))}
              </select>
            ) : (
              <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.subaccountId}
                onChange={(e) => setForm((p: any) => ({ ...p, subaccountId: Number(e.target.value) }))} placeholder="e.g. 0" />
            )}
          </div>

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Markets Allowlist</div>
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Select Markets</div>
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
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Or CSV</div>
            <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.marketsAllowlistCsv} onChange={(e) => setForm((p: any) => ({ ...p, marketsAllowlistCsv: e.target.value }))} placeholder="e.g. 0,1,2,3" />
          </div>

          <div>
            <div className="text-gray-400 mb-1">Max Makers Per Fill</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxMakersPerFill}
              onChange={(e) => setForm((p: any) => ({ ...p, maxMakersPerFill: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="h-4 w-4" checked={!!form.allowAmmFills} onChange={(e) => setForm((p: any) => ({ ...p, allowAmmFills: e.target.checked }))} />
            <span className="text-gray-300">Allow AMM/JIT Fills</span>
          </label>

          <div>
            <div className="text-gray-400 mb-1">Skip Young Order (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.skipYoungOrderMs}
              onChange={(e) => setForm((p: any) => ({ ...p, skipYoungOrderMs: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="h-4 w-4" checked={!!form.requireExistingMakers}
              onChange={(e) => setForm((p: any) => ({ ...p, requireExistingMakers: e.target.checked }))} />
            <span className="text-gray-300">Require Existing Makers</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Min Maker Count Per Node</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minMakerCountPerNode}
              onChange={(e) => setForm((p: any) => ({ ...p, minMakerCountPerNode: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Deny JIT Takers TTL (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.denyJitTakersTtlMs}
              onChange={(e) => setForm((p: any) => ({ ...p, denyJitTakersTtlMs: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Min Tip Floor to Attempt (lamports)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minTipFloorToAttemptLamports}
              onChange={(e) => setForm((p: any) => ({ ...p, minTipFloorToAttemptLamports: Math.max(0, Number(e.target.value)) }))} />
          </div>

          <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Profitability & Prebuild</div>
          <div>
            <div className="text-gray-400 mb-1">Min Notional (quote)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minNotionalQuote}
              onChange={(e) => setForm((p: any) => ({ ...p, minNotionalQuote: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Min Remaining Base (units)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minRemainingBase}
              onChange={(e) => setForm((p: any) => ({ ...p, minRemainingBase: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Reward Share (0-1)</div>
            <input type="number" step="0.01" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.rewardShare}
              onChange={(e) => setForm((p: any) => ({ ...p, rewardShare: Math.max(0, Math.min(1, Number(e.target.value))) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Min Reward (quote)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minRewardQuote}
              onChange={(e) => setForm((p: any) => ({ ...p, minRewardQuote: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Min Profit (quote)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minProfitQuote}
              onChange={(e) => setForm((p: any) => ({ ...p, minProfitQuote: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Min Reward / Cost Ratio</div>
            <input type="number" step="0.1" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.minRewardToCostRatio}
              onChange={(e) => setForm((p: any) => ({ ...p, minRewardToCostRatio: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Max Candidates / Loop</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.maxCandidatesPerLoop}
              onChange={(e) => setForm((p: any) => ({ ...p, maxCandidatesPerLoop: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Rank By</div>
            <select className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.rankBy}
              onChange={(e) => setForm((p: any) => ({ ...p, rankBy: e.target.value }))}>
              <option value="profit">profit</option>
              <option value="reward">reward</option>
              <option value="notional">notional</option>
            </select>
          </div>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="h-4 w-4" checked={!!form.prebuildEnabled}
              onChange={(e) => setForm((p: any) => ({ ...p, prebuildEnabled: e.target.checked }))} />
            <span className="text-gray-300">Enable Prebuild</span>
          </label>
          <div>
            <div className="text-gray-400 mb-1">Prebuild Distance (bps)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.prebuildDistanceBps}
              onChange={(e) => setForm((p: any) => ({ ...p, prebuildDistanceBps: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Prebuild TTL (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.prebuildTtlMs}
              onChange={(e) => setForm((p: any) => ({ ...p, prebuildTtlMs: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Prebuild Max Candidates</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.prebuildMaxCandidates}
              onChange={(e) => setForm((p: any) => ({ ...p, prebuildMaxCandidates: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Prebuild Per Loop</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.prebuildPerLoop}
              onChange={(e) => setForm((p: any) => ({ ...p, prebuildPerLoop: Math.max(0, Number(e.target.value)) }))} />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Prebuild Max In-Flight</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.prebuildMaxInFlight}
              onChange={(e) => setForm((p: any) => ({ ...p, prebuildMaxInFlight: Math.max(0, Number(e.target.value)) }))} />
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

export default FillerRunnerConfig;


