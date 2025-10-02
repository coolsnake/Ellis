import React, { useEffect, useMemo, useState } from 'react';

type DriftStatus = {
  cluster: 'mainnet-beta' | 'devnet' | 'localnet';
  programId?: string;
  subaccounts: Array<{ id: number; freeCollateral: number; totalCollateral: number; maintenanceRequirement: number; initialRequirement: number; effectiveLeverage: number }>;
  markets: Array<{ marketIndex: number; symbol?: string }>;
};

interface LeveragedGridConfigProps {
  onClose: () => void;
}

export const LeveragedGridConfig: React.FC<LeveragedGridConfigProps> = ({ onClose }) => {
  const [status, setStatus] = useState<DriftStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState<boolean>(false);

  const [form, setForm] = useState<any>({
    name: '',
    marketIndex: 0,
    subaccountId: 0,
    leverage: 2,
    liquidationBufferPct: 0.25,
    gridLower: 0,
    gridUpper: 0,
    levels: 5,
    stepPct: 0.01,
    notionalPerLevel: 100,
    makerOnly: true,
    fundingGuard: true,
    rebalanceHysteresisPct: 0.02,
    maxOpenOrders: 20,
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/drift/status');
        const data = await res.json();
        if (!alive) return;
        setStatus(data);
        if (Array.isArray(data?.subaccounts) && typeof data?.subaccounts?.[0]?.id === 'number') {
          setForm((prev: any) => ({ ...prev, subaccountId: data.subaccounts[0].id }));
        }
        // If markets exist and current is invalid, default to first
        if (Array.isArray(data?.markets) && data.markets.length > 0) {
          const currentIdx = Number(form.marketIndex);
          if (!Number.isFinite(currentIdx) || currentIdx < 0) {
            setForm((prev: any) => ({ ...prev, marketIndex: Number(data.markets[0].marketIndex) }));
          }
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  const markets = useMemo(() => status?.markets || [], [status]);
  const subaccounts = useMemo(() => status?.subaccounts || [], [status]);
  const [l2, setL2] = useState<{ bid: Array<{ price: number; size: number }>; ask: Array<{ price: number; size: number }>; oracle?: number } | null>(null);
  const [funding, setFunding] = useState<{ lastFundingRate: number; cumulativeFunding: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const idx = Number(form.marketIndex);
    if (!Number.isFinite(idx)) return;
    (async () => {
      try {
        const res = await fetch(`/api/drift/l2?marketIndex=${idx}`);
        const data = await res.json();
        if (!alive) return;
        setL2(data);
      } catch {}
    })();
    (async () => {
      try {
        const res = await fetch(`/api/drift/funding?marketIndex=${idx}`);
        const data = await res.json();
        if (!alive) return;
        setFunding(data);
      } catch {}
    })();
    return () => { alive = false; };
  }, [form.marketIndex]);

  const handleSave = async () => {
    // basic validation
    if (!form.name || String(form.name).trim().length < 2) {
      setError('Please provide a strategy name');
      return;
    }
    if (!Number.isFinite(Number(form.levels)) || Number(form.levels) < 1) {
      setError('Levels must be at least 1');
      return;
    }
    if (Number(form.gridLower) && Number(form.gridUpper) && Number(form.gridUpper) <= Number(form.gridLower)) {
      setError('Upper bound must be greater than lower bound');
      return;
    }
    if (!Number.isFinite(Number(form.notionalPerLevel)) || Number(form.notionalPerLevel) <= 0) {
      setError('Notional per level must be positive');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const cfg = {
        name: form.name || `lev-grid-${Date.now()}`,
        market: { marketIndex: Number(form.marketIndex) },
        subaccountId: Number(form.subaccountId),
        leverage: Number(form.leverage),
        liquidationBufferPct: Number(form.liquidationBufferPct),
        gridLower: Number(form.gridLower),
        gridUpper: Number(form.gridUpper),
        levels: Number(form.levels),
        stepPct: Number(form.stepPct),
        notionalPerLevel: Number(form.notionalPerLevel),
        makerOnly: !!form.makerOnly,
        fundingGuard: !!form.fundingGuard,
        rebalanceHysteresisPct: Number(form.rebalanceHysteresisPct),
        maxOpenOrders: Number(form.maxOpenOrders),
        enabled: true,
      };
      const res = await fetch('/api/strategies/leveraged-grid/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      if (!res.ok) throw new Error(await res.text());
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleSwitchSub = async (id: number) => {
    try {
      await fetch('/api/drift/subaccount/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      // refresh status to pick up subaccount details
      try {
        const res = await fetch('/api/drift/status');
        const data = await res.json();
        setStatus(data);
      } catch {}
    } catch {}
  };

  const refreshSubaccounts = async () => {
    try {
      const res = await fetch('/api/drift/subaccounts');
      const data = await res.json();
      if (data && Array.isArray(data.subaccounts)) {
        setStatus((prev) => prev ? { ...prev, subaccounts: data.subaccounts } : prev);
      }
    } catch {}
  };

  const handleCreateSub = async () => {
    try {
      setOpBusy(true);
      setError(null);
      const res = await fetch('/api/drift/subaccount/create', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(await res.text());
      const created = await res.json();
      await refreshSubaccounts();
      if (created && typeof created.id === 'number') {
        setForm((prev: any) => ({ ...prev, subaccountId: Number(created.id) }));
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setOpBusy(false);
    }
  };

  const [amount, setAmount] = useState<number>(0);
  const [spotMarketIndex, setSpotMarketIndex] = useState<number>(0);

  const doSubaccountOp = async (kind: 'deposit' | 'withdraw') => {
    try {
      setOpBusy(true);
      setError(null);
      const body = { subaccountId: Number(form.subaccountId), amount: Number(amount), spotMarketIndex: Number(spotMarketIndex) };
      if (!Number.isFinite(body.subaccountId)) throw new Error('Invalid subaccount');
      if (!Number.isFinite(body.amount) || body.amount <= 0) throw new Error('Enter a positive amount');
      const res = await fetch(`/api/drift/subaccount/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      if (!out?.ok) throw new Error(`${kind} failed`);
      await refreshSubaccounts();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setOpBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-5xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Leveraged Grid (Drift)</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">Strategy Name</label>
              <input className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. SOL-PERP Lev Grid" />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">Market</label>
              <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.marketIndex} onChange={e => setForm({ ...form, marketIndex: Number(e.target.value) })}>
                {(markets || []).map(m => (
                  <option key={m.marketIndex} value={m.marketIndex}>{m.symbol ? `${m.symbol} (${m.marketIndex})` : `Market ${m.marketIndex}`}</option>
                ))}
              </select>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">Subaccount</label>
              <div className="flex space-x-2">
                <select className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.subaccountId} onChange={e => { const id = Number(e.target.value); setForm({ ...form, subaccountId: id }); handleSwitchSub(id); }}>
                  {(subaccounts || []).map(s => (<option key={s.id} value={s.id}>Sub {s.id}</option>))}
                </select>
                <button disabled={opBusy} onClick={handleCreateSub} className="px-3 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-60" title="Create subaccount">{opBusy ? 'Working...' : 'Create'}</button>
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">Subaccount Funds</label>
              <div className="grid grid-cols-3 gap-2">
                <input type="number" min={0} step={0.000001} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={amount} onChange={e => setAmount(Number(e.target.value))} placeholder="Amount (e.g. USDC)" />
                <input type="number" min={0} step={1} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={spotMarketIndex} onChange={e => setSpotMarketIndex(Number(e.target.value))} placeholder="Spot Market Index (0=USDC)" />
                <div className="flex space-x-2">
                  <button disabled={opBusy} onClick={() => doSubaccountOp('deposit')} className="flex-1 px-3 py-2 bg-green-700 text-white rounded hover:bg-green-800 disabled:opacity-60">Deposit</button>
                  <button disabled={opBusy} onClick={() => doSubaccountOp('withdraw')} className="flex-1 px-3 py-2 bg-red-700 text-white rounded hover:bg-red-800 disabled:opacity-60">Withdraw</button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Leverage (max)</label>
                <input type="number" min={1} step={0.1} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.leverage} onChange={e => setForm({ ...form, leverage: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Liquidation Buffer (%)</label>
                <input type="number" min={0} step={0.01} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.liquidationBufferPct} onChange={e => setForm({ ...form, liquidationBufferPct: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Levels per side</label>
                <input type="number" min={1} max={50} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.levels} onChange={e => setForm({ ...form, levels: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Step (%)</label>
                <input type="number" min={0.001} step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.stepPct} onChange={e => setForm({ ...form, stepPct: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Lower Bound (0 = auto)</label>
                <input type="number" step={0.000001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.gridLower} onChange={e => setForm({ ...form, gridLower: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Upper Bound (0 = auto)</label>
                <input type="number" step={0.000001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.gridUpper} onChange={e => setForm({ ...form, gridUpper: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Notional per Level (quote)</label>
                <input type="number" min={1} step={1} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.notionalPerLevel} onChange={e => setForm({ ...form, notionalPerLevel: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Open Orders</label>
                <input type="number" min={2} step={1} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.maxOpenOrders} onChange={e => setForm({ ...form, maxOpenOrders: Number(e.target.value) })} />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <label className="flex items-center space-x-2"><input type="checkbox" checked={form.makerOnly} onChange={e => setForm({ ...form, makerOnly: e.target.checked })} /><span className="text-gray-300">Maker-only</span></label>
              <label className="flex items-center space-x-2"><input type="checkbox" checked={form.fundingGuard} onChange={e => setForm({ ...form, fundingGuard: e.target.checked })} /><span className="text-gray-300">Funding guard</span></label>
            </div>
          </div>

          <div>
            <div className="mb-4 p-3 rounded bg-gray-700 border border-gray-600">
              <div className="text-white font-semibold mb-2">Subaccount Overview</div>
              {loading && <div className="text-gray-300 text-sm">Loading Drift status...</div>}
              {!loading && (!subaccounts || subaccounts.length === 0) && <div className="text-gray-400 text-sm">No subaccounts detected.</div>}
              {!loading && subaccounts && subaccounts.length > 0 && (
                <div className="space-y-2">
                  {subaccounts.map(s => (
                    <div key={s.id} className={`p-2 rounded ${s.id === form.subaccountId ? 'bg-gray-800' : 'bg-gray-750'}`}>
                      <div className="text-gray-200">Sub {s.id}</div>
                      <div className="grid grid-cols-2 gap-2 text-sm text-gray-300 mt-1">
                        <div>Free Collateral: <span className="text-white">{s.freeCollateral.toFixed(2)}</span></div>
                        <div>Total Collateral: <span className="text-white">{s.totalCollateral.toFixed(2)}</span></div>
                        <div>Initial Req: <span className="text-white">{s.initialRequirement.toFixed(2)}</span></div>
                        <div>Maintenance: <span className="text-white">{s.maintenanceRequirement.toFixed(2)}</span></div>
                        <div>Eff. Leverage: <span className="text-white">{s.effectiveLeverage.toFixed(2)}</span></div>
                      </div>
                      {(s as any).positions && (s as any).positions.length > 0 && (
                        <div className="mt-2 text-sm text-gray-300">
                          <div className="mb-1">Perp Positions:</div>
                          <div className="space-y-1 max-h-24 overflow-y-auto">
                            {(s as any).positions.map((p: any, i: number) => (
                              <div key={i} className="flex justify-between">
                                <span>Market {p.marketIndex}</span>
                                <span className="text-white">Base: {Number(p.base || 0)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mb-4 p-3 rounded bg-gray-700 border border-gray-600">
              <div className="text-white font-semibold mb-2">Market Preview</div>
              {l2 ? (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-gray-300 mb-1">Bids</div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {(l2.bid || []).slice(0, 10).map((r, i) => (
                        <div key={i} className="flex justify-between"><span className="text-green-300">{r.price}</span><span className="text-gray-200">{r.size}</span></div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-300 mb-1">Asks</div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {(l2.ask || []).slice(0, 10).map((r, i) => (
                        <div key={i} className="flex justify-between"><span className="text-red-300">{r.price}</span><span className="text-gray-200">{r.size}</span></div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-gray-400 text-sm">Orderbook preview unavailable.</div>
              )}
              <div className="mt-3 text-sm text-gray-300">
                Funding: <span className="text-white">{funding ? `${(funding.lastFundingRate * 100).toFixed(3)}% last, ${(funding.cumulativeFunding * 100).toFixed(3)}% cum` : '...'}</span>
              </div>
            </div>

            <div className="mb-4 p-3 rounded bg-gray-700 border border-gray-600">
              <div className="text-white font-semibold mb-2">Run</div>
              <button disabled={saving} onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60">{saving ? 'Starting...' : 'Start Leveraged Grid'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


