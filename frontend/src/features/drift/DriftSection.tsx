import React, { useEffect, useMemo, useState } from 'react';
import { LiquidationMonitor } from '../drift';
import { LiquidatorStatus } from '../../components/LiquidatorStatus';
import { ROUTES } from '../../utils/routes';
import { useSocket } from '../../app/contexts/socket';

export const DriftSection: React.FC<{
  apiBase: string;
  driftSubaccounts: any[];
  driftSelectedSubId: number;
  driftNewSubName: string;
  driftRenameSubName: string;
  driftOpBusy: boolean;
  setDriftSelectedSubId: (id: number) => void;
  setDriftNewSubName: (s: string) => void;
  setDriftRenameSubName: (s: string) => void;
  setDriftOpBusy: (v: boolean) => void;
  setDriftSubaccounts: (list: any[]) => void;
  ls: Array<{ key: string }>;
  onOpenLiqRunner?: () => void;
}> = (p) => {
  const { socket: ctxSocket } = useSocket();
  const [status, setStatus] = useState<any>(null);
  const [balances, setBalances] = useState<any[]>([]);
  const [spotMarkets, setSpotMarkets] = useState<Array<{ marketIndex: number; symbol?: string }>>([]);
  const [amount, setAmount] = useState<number>(0);
  const [spotIndex, setSpotIndex] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [liqUsers, setLiqUsers] = useState<Array<{ userPk: string; health: number; updatedAt: number; positions?: Array<{ marketIndex: number; base: number }> }>>([]);

  const selected = useMemo(
    () => p.driftSubaccounts.find((s: any) => Number(s.id) === Number(p.driftSelectedSubId)),
    [p.driftSubaccounts, p.driftSelectedSubId]
  );

  const loadStatusAndSubs = async () => {
    try {
      setLoading(true);
      setError(null);
      const [stRes, mkRes] = await Promise.all([
        fetch(`${p.apiBase}${ROUTES.drift.status}`),
        fetch(`${p.apiBase}${ROUTES.drift.spotMarkets}`),
      ]);
      const st = await stRes.json().catch(() => ({}));
      const mk = await mkRes.json().catch(() => ({}));
      setStatus(st || null);
      if (Array.isArray(st?.subaccounts)) p.setDriftSubaccounts(st.subaccounts);
      if (Array.isArray(mk?.markets)) setSpotMarkets(mk.markets);
      // Default selection if needed
      if (!Number.isFinite(Number(p.driftSelectedSubId)) && Array.isArray(st?.subaccounts) && st.subaccounts.length > 0) {
        try { p.setDriftSelectedSubId(Number(st.subaccounts[0].id)); } catch {}
      }
      // Default spot index
      const firstIdx = Array.isArray(mk?.markets) && mk.markets.length > 0 ? Number(mk.markets[0].marketIndex) : 0;
      setSpotIndex((v) => (Number.isFinite(v) ? v : firstIdx));
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const loadSubaccounts = async () => {
    try {
      const res = await fetch(`${p.apiBase}/drift/subaccounts`);
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data?.subaccounts)) p.setDriftSubaccounts(data.subaccounts);
      if (Number.isFinite(Number(data?.selectedId))) p.setDriftSelectedSubId(Number(data.selectedId));
    } catch {}
  };

  const loadBalances = async (subId: number) => {
    if (!Number.isFinite(Number(subId))) { setBalances([]); return; }
    try {
      const r = await fetch(`${p.apiBase}${ROUTES.drift.subaccountBalances}?subaccountId=${Number(subId)}`);
      const b = await r.json().catch(() => ({}));
      setBalances(Array.isArray(b?.balances) ? b.balances : []);
    } catch {}
  };

  useEffect(() => { loadStatusAndSubs(); loadSubaccounts(); }, []);
  useEffect(() => { loadBalances(p.driftSelectedSubId); }, [p.apiBase, p.driftSelectedSubId]);
  useEffect(() => {
    const s = ctxSocket;
    if (!s) return;
    const onBal = (evt: any) => {
      try {
        if (Number(evt?.subaccountId) === Number(p.driftSelectedSubId)) {
          loadBalances(p.driftSelectedSubId);
        }
      } catch {}
    };
    try { s.on('drift:user:balances', onBal); } catch {}
    return () => { try { s.off('drift:user:balances', onBal); } catch {} };
  }, [ctxSocket, p.driftSelectedSubId]);

  // Listen for liquidation users list updates
  useEffect(() => {
    const s = ctxSocket;
    if (!s) return;
    const onLiq = (evt: any) => {
      try {
        if (evt && typeof evt === 'object' && evt.type === 'queue' && Array.isArray(evt.users)) {
          setLiqUsers(evt.users as any);
        }
      } catch {}
    };
    try { s.on('drift-liquidation', onLiq); } catch {}
    return () => { try { s.off('drift-liquidation', onLiq); } catch {} };
  }, [ctxSocket]);

  const createSub = async () => {
    try {
      p.setDriftOpBusy(true);
      setError(null);
      const name = (p.driftNewSubName || '').trim();
      const res = await fetch(`${p.apiBase}${ROUTES.drift.subaccountCreate}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(name ? { name } : {}) });
      if (!res.ok) throw new Error((await res.text()) || 'Create unavailable');
      const created = await res.json();
      await loadStatusAndSubs();
      await loadSubaccounts();
      if (created && typeof created.id === 'number') p.setDriftSelectedSubId(Number(created.id));
      try { p.setDriftNewSubName(''); } catch {}
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      p.setDriftOpBusy(false);
    }
  };

  const switchSub = async (id: number) => {
    try {
      p.setDriftOpBusy(true);
      setError(null);
      await fetch(`${p.apiBase}${ROUTES.drift.subaccountSwitch}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(id) }),
      });
      await loadStatusAndSubs();
      await loadSubaccounts();
      await loadBalances(id);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      p.setDriftOpBusy(false);
    }
  };

  const doSubOp = async (kind: 'deposit' | 'withdraw') => {
    try {
      p.setDriftOpBusy(true);
      setError(null);
      const body = {
        subaccountId: Number(p.driftSelectedSubId),
        amount: Number(amount),
        spotMarketIndex: Number(spotIndex),
      };
      if (!Number.isFinite(body.subaccountId)) throw new Error('Invalid subaccount');
      if (!Number.isFinite(body.amount) || body.amount <= 0) throw new Error('Enter a positive amount');
      const endpoint = kind === 'deposit' ? ROUTES.drift.subaccountDeposit : ROUTES.drift.subaccountWithdraw;
      const res = await fetch(`${p.apiBase}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json().catch(() => ({}));
      if (out && out.ok === false) throw new Error(`${kind} failed`);
      await loadBalances(p.driftSelectedSubId);
      await loadStatusAndSubs();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      p.setDriftOpBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="p-3 bg-gray-800 rounded md:col-span-2">
        <div className="flex items-center justify-between mb-2">
          <div className="text-white font-semibold">Subaccounts</div>
          <div className="flex items-center gap-2">
            <input
              className="px-2 py-1 bg-gray-700 rounded text-white text-sm placeholder-gray-400"
              placeholder="Name (optional)"
              value={p.driftNewSubName}
              onChange={(e) => p.setDriftNewSubName(e.target.value)}
            />
            <button className="px-2 py-1 bg-gray-700 rounded text-white text-sm" onClick={loadStatusAndSubs} disabled={loading}>Refresh</button>
            <button className="px-2 py-1 bg-blue-600 rounded text-white text-sm" onClick={createSub} disabled={p.driftOpBusy}>+ Create</button>
          </div>
        </div>
        {error && <div className="mb-2 text-sm text-red-300">{error}</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-gray-300 mb-1">Select Subaccount</label>
            <div className="flex gap-2">
              <select
                className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white"
                value={Number.isFinite(Number(p.driftSelectedSubId)) ? Number(p.driftSelectedSubId) : ''}
                onChange={(e) => p.setDriftSelectedSubId(Number(e.target.value))}
              >
                {(p.driftSubaccounts || []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {typeof s.name === 'string' && s.name.length ? `${s.name} (#${s.id})` : `Sub #${s.id}`}
                  </option>
                ))}
              </select>
              <button
                className="px-2 py-1 border border-gray-600 rounded text-sm text-white"
                onClick={() => switchSub(Number(p.driftSelectedSubId))}
                disabled={p.driftOpBusy || !Number.isFinite(Number(p.driftSelectedSubId))}
              >
                Switch
              </button>
            </div>
            {selected && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-300">
                <div>
                  <div className="text-gray-400">Free Collateral</div>
                  <div className="text-white">{Number(selected.freeCollateral ?? 0).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-gray-400">Total Collateral</div>
                  <div className="text-white">{Number(selected.totalCollateral ?? 0).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-gray-400">Initial Requirement</div>
                  <div className="text-white">{Number(selected.initialRequirement ?? 0).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-gray-400">Maintenance Requirement</div>
                  <div className="text-white">{Number(selected.maintenanceRequirement ?? 0).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-gray-400">Effective Leverage</div>
                  <div className="text-white">{Number(selected.effectiveLeverage ?? 0).toFixed(2)}x</div>
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1">Deposit / Withdraw</label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-xs text-gray-400 mb-1">Spot Market</div>
                <select
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white"
                  value={spotIndex}
                  onChange={(e) => setSpotIndex(Number(e.target.value))}
                >
                  {(spotMarkets || []).map((m) => (
                    <option key={m.marketIndex} value={m.marketIndex}>
                      {m.symbol ? `${m.symbol} (${m.marketIndex})` : `Market ${m.marketIndex}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">Amount</div>
                <input
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white"
                  type="number"
                  step="0.000001"
                  value={amount}
                  onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
            <div className="mt-2 flex gap-2">
              <button className="px-3 py-1 bg-green-600 text-white rounded text-sm" onClick={() => doSubOp('deposit')} disabled={p.driftOpBusy}>
                Deposit
              </button>
              <button className="px-3 py-1 bg-red-600 text-white rounded text-sm" onClick={() => doSubOp('withdraw')} disabled={p.driftOpBusy}>
                Withdraw
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <div className="text-sm text-gray-300 mb-1">Balances{Number.isFinite(Number(p.driftSelectedSubId)) ? ` — Sub #${p.driftSelectedSubId}` : ''}</div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left">Mint</th>
                  <th className="text-left">Symbol</th>
                  <th className="text-left">Amount</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b, i) => (
                  <tr key={i} className="text-gray-300">
                    <td>{b.mint || '-'}</td>
                    <td>{b.symbol || '-'}</td>
                    <td>{Number(b.amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 9 })}</td>
                  </tr>
                ))}
                {balances.length === 0 && (
                  <tr><td colSpan={3} className="text-gray-500">No balances</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="p-3 bg-gray-800 rounded">
        <div className="flex items-center justify-between mb-2">
          <div className="text-white font-semibold">Liquidations</div>
          <div className="flex items-center gap-2">
            {!!p.onOpenLiqRunner && (
              <button className="px-2 py-1 bg-purple-600 text-white rounded text-sm" onClick={() => p.onOpenLiqRunner?.()}>+ New Liquidator</button>
            )}
          </div>
        </div>
        <div className="mb-3">
          <LiquidatorStatus apiBase={p.apiBase} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3">
          {p.ls.map((x) => (
            <LiquidationMonitor key={x.key} apiBase={p.apiBase} liquidatorKey={x.key} />
          ))}
        </div>
        <div className="mt-4 text-xs text-gray-400">
          {status?.cluster ? `Cluster: ${status.cluster}` : null}
          {status?.programId ? ` — Program: ${status.programId}` : null}
        </div>
      </div>

      {/* Users panel spanning full width */}
      <div className="p-3 bg-gray-800 rounded md:col-span-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-white font-semibold">Users</div>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left">User</th>
                <th className="text-left">Health</th>
                <th className="text-left">Updated</th>
                <th className="text-left">Positions</th>
              </tr>
            </thead>
            <tbody>
              {liqUsers.map((u) => (
                <tr key={u.userPk} className="text-gray-300">
                  <td title={u.userPk} className="font-mono">{u.userPk.slice(0, 6)}…{u.userPk.slice(-6)}</td>
                  <td className={`${u.health < -0.5 ? 'text-red-300' : u.health < 0 ? 'text-yellow-300' : 'text-white'}`}>{(u.health * 100).toFixed(2)}%</td>
                  <td className="text-gray-400">{(() => { const d = Date.now() - Number(u.updatedAt||0); return isFinite(d) ? (d < 60000 ? `${Math.max(0, Math.floor(d/1000))}s ago` : `${Math.floor(d/60000)}m ago`) : '-'; })()}</td>
                  <td>
                    {Array.isArray(u.positions) && u.positions.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {u.positions.map((p, i) => (
                          <span key={`${u.userPk}-${p.marketIndex}-${i}`} className="px-2 py-0.5 bg-gray-700 rounded text-xs">
                            m{p.marketIndex}: {Number(p.base).toLocaleString()}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-500">-</span>
                    )}
                  </td>
                </tr>
              ))}
              {liqUsers.length === 0 && (
                <tr><td colSpan={4} className="text-gray-500">No users under threshold</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

