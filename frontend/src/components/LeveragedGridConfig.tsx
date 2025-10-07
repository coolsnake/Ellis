import React, { useEffect, useMemo, useState } from 'react';
import { ROUTES } from '../utils/routes';

type DriftStatus = {
  cluster: 'mainnet-beta' | 'devnet' | 'localnet';
  programId?: string;
  subaccounts: Array<{ id: number; freeCollateral: number; totalCollateral: number; maintenanceRequirement: number; initialRequirement: number; effectiveLeverage: number }>;
  markets: Array<{ marketIndex: number; symbol?: string }>;
};

interface LeveragedGridConfigProps {
  onClose: () => void;
  onSaved?: () => void;
  initialConfig?: any;
  apiBase?: string;
}

export const LeveragedGridConfig: React.FC<LeveragedGridConfigProps> = ({ onClose, onSaved, initialConfig, apiBase = '/api' }) => {
  const [status, setStatus] = useState<DriftStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState<boolean>(false);

  const [form, setForm] = useState<any>({
    name: initialConfig?.name || '',
    marketIndex: initialConfig?.marketIndex ?? 0,
    subaccountId: initialConfig?.subaccountId ?? 0,
    leverage: 2,
    liquidationBufferPct: 0.25,
    // Grid-style params mirroring classic grid
    gridType: 'arithmetic',
    gridSpacing: 0.01,
    levels: 5,
    centerPrice: 0,
    totalAmount: 1,
    levelAmount: 0.1,
    bias: 'neutral',
    biasStrength: 0,
    initialBuyRange: 0.05,
    initialSellRange: 0.05,
    maxPositions: 10,
    stopLoss: 0,
    takeProfit: 0,
    rebalanceThreshold: 0.05,
    adaptiveSpacing: false,
    volatilityPeriod: 20,
    minLevelSpacing: 0.005,
    maxLevelSpacing: 0.02,
    slidingCenter: false,
    slideRate: 10,
    slideMaxDistance: 5,
    slippageBps: 100,
    cooldownMs: 1000,
    feeBps: 30,
    extraSlippageBps: 50,
    minEdgeBps: 60,
    // Drift execution specifics
    gridLower: 0,
    gridUpper: 0,
    stepPct: 0.01,
    notionalPerLevel: 100,
    makerOnly: true,
    fundingGuard: true,
    rebalanceHysteresisPct: 0.02,
    maxOpenOrders: 20,
  });

  const isEdit = !!(initialConfig && (initialConfig.driftKey || (initialConfig.name && Number.isFinite(Number(initialConfig.marketIndex)) && Number.isFinite(Number(initialConfig.subaccountId)))));

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        setLoading(true);
        const res = await fetch(`${apiBase}${ROUTES.drift.status}`);
        const data = await res.json();
        if (!alive) return;
        setStatus(data);
        if (Array.isArray(data?.subaccounts) && typeof data?.subaccounts?.[0]?.id === 'number') {
          setForm((prev: any) => ({ ...prev, subaccountId: prev.subaccountId ?? data.subaccounts[0].id }));
        }
        // If markets exist and current is invalid, default to first
        if (Array.isArray(data?.markets) && data.markets.length > 0) {
          const currentIdx = Number(form.marketIndex);
          if (!Number.isFinite(currentIdx) || currentIdx < 0) {
            setForm((prev: any) => ({ ...prev, marketIndex: Number(data.markets[0].marketIndex) }));
          }
        }
        // If editing, try to prefill from current runner status for full fidelity
        if (isEdit) {
          try {
            const statusRes = await fetch(`${apiBase}${ROUTES.strategies.leveragedGrid.status}`);
            const statusJson = await statusRes.json();
            const list = Array.isArray(statusJson?.strategies) ? statusJson.strategies : [];
            const key = String(initialConfig?.driftKey || `${initialConfig?.name}#${initialConfig?.marketIndex}#${initialConfig?.subaccountId}`);
            const match = list.find((x: any) => String(x?.key) === key);
            const cfg = match?.status?.config || null;
            if (cfg) {
              setForm((prev: any) => ({
                ...prev,
                name: cfg.name ?? prev.name,
                marketIndex: Number(cfg?.market?.marketIndex ?? prev.marketIndex),
                subaccountId: Number(cfg?.subaccountId ?? prev.subaccountId),
                leverage: Number(cfg?.leverage ?? prev.leverage),
                liquidationBufferPct: Number(cfg?.liquidationBufferPct ?? prev.liquidationBufferPct),
                gridType: cfg?.gridType ?? prev.gridType,
                gridSpacing: Number(cfg?.gridSpacing ?? prev.gridSpacing),
                centerPrice: Number(cfg?.centerPrice ?? prev.centerPrice),
                totalAmount: Number(cfg?.totalAmount ?? prev.totalAmount),
                levelAmount: Number(cfg?.levelAmount ?? prev.levelAmount),
                bias: cfg?.bias ?? prev.bias,
                biasStrength: Number(cfg?.biasStrength ?? prev.biasStrength),
                initialBuyRange: Number(cfg?.initialBuyRange ?? prev.initialBuyRange),
                initialSellRange: Number(cfg?.initialSellRange ?? prev.initialSellRange),
                maxPositions: Number(cfg?.maxPositions ?? prev.maxPositions),
                stopLoss: Number(cfg?.stopLoss ?? prev.stopLoss),
                takeProfit: Number(cfg?.takeProfit ?? prev.takeProfit),
                rebalanceThreshold: Number(cfg?.rebalanceThreshold ?? prev.rebalanceThreshold),
                adaptiveSpacing: !!(cfg?.adaptiveSpacing ?? prev.adaptiveSpacing),
                volatilityPeriod: Number(cfg?.volatilityPeriod ?? prev.volatilityPeriod),
                minLevelSpacing: Number(cfg?.minLevelSpacing ?? prev.minLevelSpacing),
                maxLevelSpacing: Number(cfg?.maxLevelSpacing ?? prev.maxLevelSpacing),
                slidingCenter: !!(cfg?.slidingCenter ?? prev.slidingCenter),
                slideRate: Number(cfg?.slideRate ?? prev.slideRate),
                slideMaxDistance: Number(cfg?.slideMaxDistance ?? prev.slideMaxDistance),
                slippageBps: Number(cfg?.slippageBps ?? prev.slippageBps),
                cooldownMs: Number(cfg?.cooldownMs ?? prev.cooldownMs),
                feeBps: Number(cfg?.feeBps ?? prev.feeBps),
                extraSlippageBps: Number(cfg?.extraSlippageBps ?? prev.extraSlippageBps),
                minEdgeBps: Number(cfg?.minEdgeBps ?? prev.minEdgeBps),
                gridLower: Number(cfg?.gridLower ?? prev.gridLower),
                gridUpper: Number(cfg?.gridUpper ?? prev.gridUpper),
                levels: Number(cfg?.levels ?? prev.levels),
                stepPct: Number(cfg?.stepPct ?? prev.stepPct),
                notionalPerLevel: Number(cfg?.notionalPerLevel ?? prev.notionalPerLevel),
                makerOnly: !!(cfg?.makerOnly ?? prev.makerOnly),
                fundingGuard: !!(cfg?.fundingGuard ?? prev.fundingGuard),
                rebalanceHysteresisPct: Number(cfg?.rebalanceHysteresisPct ?? prev.rebalanceHysteresisPct),
                maxOpenOrders: Number(cfg?.maxOpenOrders ?? prev.maxOpenOrders),
              }));
            }
          } catch {}
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, [isEdit, initialConfig]);

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
        const res = await fetch(`${apiBase}${ROUTES.drift.l2}?marketIndex=${idx}`);
        const data = await res.json();
        if (!alive) return;
        setL2(data);
      } catch {}
    })();
    (async () => {
      try {
        const res = await fetch(`${apiBase}${ROUTES.drift.funding}?marketIndex=${idx}`);
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
        // Mirrored grid params (best-effort passthrough for backend reference/analytics)
        gridType: form.gridType,
        gridSpacing: Number(form.gridSpacing),
        centerPrice: Number(form.centerPrice),
        totalAmount: Number(form.totalAmount),
        levelAmount: Number(form.levelAmount),
        bias: form.bias,
        biasStrength: Number(form.biasStrength),
        initialBuyRange: Number(form.initialBuyRange),
        initialSellRange: Number(form.initialSellRange),
        maxPositions: Number(form.maxPositions),
        stopLoss: Number(form.stopLoss),
        takeProfit: Number(form.takeProfit),
        rebalanceThreshold: Number(form.rebalanceThreshold),
        adaptiveSpacing: !!form.adaptiveSpacing,
        volatilityPeriod: Number(form.volatilityPeriod),
        minLevelSpacing: Number(form.minLevelSpacing),
        maxLevelSpacing: Number(form.maxLevelSpacing),
        slidingCenter: !!form.slidingCenter,
        slideRate: Number(form.slideRate),
        slideMaxDistance: Number(form.slideMaxDistance),
        slippageBps: Number(form.slippageBps),
        cooldownMs: Number(form.cooldownMs),
        feeBps: Number(form.feeBps),
        extraSlippageBps: Number(form.extraSlippageBps),
        minEdgeBps: Number(form.minEdgeBps),
        // Drift execution essentials
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
      // In edit mode, lock identity fields and call update endpoint
      const body = isEdit ? {
        ...cfg,
        name: initialConfig?.name ?? cfg.name,
        market: { marketIndex: Number(initialConfig?.marketIndex ?? cfg.market.marketIndex) },
        subaccountId: Number(initialConfig?.subaccountId ?? cfg.subaccountId),
      } : cfg;
      const endpoint = isEdit ? ROUTES.strategies.leveragedGrid.update : ROUTES.strategies.leveragedGrid.start;
      const res = await fetch(`${apiBase}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      try { onSaved && onSaved(); } catch {}
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleSwitchSub = async (id: number) => {
    try {
      await fetch(`${apiBase}${ROUTES.drift.subaccountSwitch}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      // refresh status to pick up subaccount details
      try {
        const res = await fetch(`${apiBase}${ROUTES.drift.status}`);
        const data = await res.json();
        setStatus(data);
      } catch {}
    } catch {}
  };

  const refreshSubaccounts = async () => {
    try {
      const res = await fetch(`${apiBase}${ROUTES.drift.subaccounts}`);
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
      const res = await fetch(`${apiBase}${ROUTES.drift.subaccountCreate}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
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
      const endpoint = kind === 'deposit' ? ROUTES.drift.subaccountDeposit : ROUTES.drift.subaccountWithdraw;
      const res = await fetch(`${apiBase}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
          <h2 className="text-2xl font-bold text-white">{isEdit ? 'Edit Leveraged Grid' : 'Leveraged Grid (Drift)'}</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">Strategy Name</label>
              <input className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. SOL-PERP Lev Grid" disabled={isEdit} />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-300 mb-2">Market</label>
              <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.marketIndex} onChange={e => setForm({ ...form, marketIndex: Number(e.target.value) })} disabled={isEdit}>
                {(markets || []).map(m => (
                  <option key={m.marketIndex} value={m.marketIndex}>{m.symbol ? `${m.symbol} (${m.marketIndex})` : `Market ${m.marketIndex}`}</option>
                ))}
              </select>
            </div>

            {/* Subaccount management removed for streamlined config */}

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
                <label className="block text-sm font-medium text-gray-300 mb-2">Grid Type</label>
                <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.gridType} onChange={e => setForm({ ...form, gridType: e.target.value })}>
                  <option value="arithmetic">Arithmetic</option>
                  <option value="geometric">Geometric</option>
                  <option value="fibonacci">Fibonacci</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Grid Spacing (%)</label>
                <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.gridSpacing} onChange={e => setForm({ ...form, gridSpacing: Number(e.target.value) })} />
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
                <label className="block text-sm font-medium text-gray-300 mb-2">Center Price (0 = auto)</label>
                <input type="number" step={0.000001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.centerPrice} onChange={e => setForm({ ...form, centerPrice: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Total Amount</label>
                <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.totalAmount} onChange={e => setForm({ ...form, totalAmount: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Level Amount</label>
                <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.levelAmount} onChange={e => setForm({ ...form, levelAmount: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Initial Buy Range (%)</label>
                <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.initialBuyRange} onChange={e => setForm({ ...form, initialBuyRange: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Initial Sell Range (%)</label>
                <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.initialSellRange} onChange={e => setForm({ ...form, initialSellRange: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Max Positions</label>
                <input type="number" min={1} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.maxPositions} onChange={e => setForm({ ...form, maxPositions: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Stop Loss (%)</label>
                <input type="number" step={0.01} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.stopLoss} onChange={e => setForm({ ...form, stopLoss: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Take Profit (%)</label>
                <input type="number" step={0.01} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.takeProfit} onChange={e => setForm({ ...form, takeProfit: Number(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Rebalance Threshold (%)</label>
                <input type="number" step={0.01} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.rebalanceThreshold} onChange={e => setForm({ ...form, rebalanceThreshold: Number(e.target.value) })} />
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
              <button disabled={saving} onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60">{saving ? (isEdit ? 'Saving...' : 'Starting...') : (isEdit ? 'Save Changes' : 'Start Leveraged Grid')}</button>
            </div>

            <div className="mb-4 p-3 rounded bg-gray-700 border border-gray-600">
              <div className="text-white font-semibold mb-2">Advanced</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="flex items-center space-x-2"><input type="checkbox" checked={form.adaptiveSpacing} onChange={e => setForm({ ...form, adaptiveSpacing: e.target.checked })} /><span className="text-gray-300">Adaptive Spacing</span></label>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Volatility Period</label>
                  <input type="number" min={5} max={100} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.volatilityPeriod} onChange={e => setForm({ ...form, volatilityPeriod: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text sm font-medium text-gray-300 mb-2">Min Level Spacing (%)</label>
                  <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.minLevelSpacing} onChange={e => setForm({ ...form, minLevelSpacing: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text sm font-medium text-gray-300 mb-2">Max Level Spacing (%)</label>
                  <input type="number" step={0.001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.maxLevelSpacing} onChange={e => setForm({ ...form, maxLevelSpacing: Number(e.target.value) })} />
                </div>
                <label className="flex items-center space-x-2"><input type="checkbox" checked={form.slidingCenter} onChange={e => setForm({ ...form, slidingCenter: e.target.checked })} /><span className="text-gray-300">Sliding Center</span></label>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Slide Rate (bps/sec)</label>
                  <input type="number" min={1} max={1000} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.slideRate} onChange={e => setForm({ ...form, slideRate: Number(e.target.value) })} disabled={!form.slidingCenter} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Max Slide Distance (%)</label>
                  <input type="number" step={0.1} min={0.1} max={50} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.slideMaxDistance} onChange={e => setForm({ ...form, slideMaxDistance: Number(e.target.value) })} disabled={!form.slidingCenter} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Slippage (bps)</label>
                  <input type="number" min={1} max={1000} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.slippageBps} onChange={e => setForm({ ...form, slippageBps: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Cooldown (ms)</label>
                  <input type="number" min={0} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.cooldownMs} onChange={e => setForm({ ...form, cooldownMs: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Fee (bps)</label>
                  <input type="number" min={0} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.feeBps} onChange={e => setForm({ ...form, feeBps: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Extra Slippage (bps)</label>
                  <input type="number" min={0} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.extraSlippageBps} onChange={e => setForm({ ...form, extraSlippageBps: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Min Edge (bps)</label>
                  <input type="number" min={0} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={form.minEdgeBps} onChange={e => setForm({ ...form, minEdgeBps: Number(e.target.value) })} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


