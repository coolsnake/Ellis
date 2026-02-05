import React, { useEffect, useMemo, useState, useRef } from 'react';
import { LiquidationMonitor, TriggerStatus, FillerStatus } from '../drift';
import { LiquidatorStatus } from '../../components/LiquidatorStatus';
import { ROUTES } from '../../utils/routes';
import { useSocket } from '../../app/contexts/socket';
import {
  Panel,
  StatCard,
  StatusBadge,
  Button,
  DataTable,
  DataTableRow,
  DataTableCell,
  InputGroup,
  Input,
  Select,
  EmptyState,
} from '../../components/ui';

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
  onOpenTriggerRunner?: () => void;
  onOpenFillerRunner?: () => void;
  onOpenExecConfig?: () => void;
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
  const [infra, setInfra] = useState<any>(null);
  const [infraBusy, setInfraBusy] = useState<boolean>(false);
  const [txSummary, setTxSummary] = useState<any>(null);
  const [txHistory, setTxHistory] = useState<any[]>([]);
  const [txBusy, setTxBusy] = useState<boolean>(false);
  const [botHealth, setBotHealth] = useState<{ liq?: any; trig?: any; fill?: any }>({});

  const selected = useMemo(
    () => p.driftSubaccounts.find((s: any) => Number(s.id) === Number(p.driftSelectedSubId)),
    [p.driftSubaccounts, p.driftSelectedSubId]
  );

  const loadStatusAndSubs = async () => {
    try {
      setLoading(true);
      setError(null);
      const [stRes, mkRes, infraRes] = await Promise.all([
        fetch(`${p.apiBase}${ROUTES.drift.status}`),
        fetch(`${p.apiBase}${ROUTES.drift.spotMarkets}`),
        fetch(`${p.apiBase}${ROUTES.drift.infraStatus}`).catch(() => null as any),
      ]);
      const st = await stRes.json().catch(() => ({}));
      const mk = await mkRes.json().catch(() => ({}));
      const si = infraRes ? (await infraRes.json().catch(() => ({}))) : null;
      setStatus(st || null);
      setInfra(si || null);
      if (Array.isArray(st?.subaccounts)) p.setDriftSubaccounts(st.subaccounts);
      if (Array.isArray(mk?.markets)) setSpotMarkets(mk.markets);
      if (!Number.isFinite(Number(p.driftSelectedSubId)) && Array.isArray(st?.subaccounts) && st.subaccounts.length > 0) {
        try { p.setDriftSelectedSubId(Number(st.subaccounts[0].id)); } catch {}
      }
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

  const loadTxSummary = async () => {
    try {
      const r = await fetch(`${p.apiBase}${ROUTES.drift.txSummary}`);
      const j = await r.json().catch(() => ({}));
      setTxSummary(j?.summary || null);
    } catch {}
  };

  const loadTxHistory = async () => {
    try {
      setTxBusy(true);
      const r = await fetch(`${p.apiBase}${ROUTES.drift.txHistory}?limit=200&includeStatus=1`);
      const j = await r.json().catch(() => ({}));
      setTxHistory(Array.isArray(j?.items) ? j.items : []);
    } catch {} finally {
      setTxBusy(false);
    }
  };

  const checkBotHealth = async () => {
    const mark = (kind: 'liq' | 'trig' | 'fill', ok: boolean, status?: number, error?: string) => {
      setBotHealth((prev) => ({
        ...prev,
        [kind]: { ok, status, error, lastAt: Date.now() },
      }));
    };
    try {
      const r = await fetch(`${p.apiBase}${ROUTES.strategies.liquidator.status}`);
      mark('liq', r.ok, r.status);
    } catch (e: any) {
      mark('liq', false, undefined, String(e?.message || e));
    }
    try {
      const r = await fetch(`${p.apiBase}${ROUTES.strategies.trigger.status}`);
      mark('trig', r.ok, r.status);
    } catch (e: any) {
      mark('trig', false, undefined, String(e?.message || e));
    }
    try {
      const r = await fetch(`${p.apiBase}${ROUTES.strategies.filler.status}`);
      mark('fill', r.ok, r.status);
    } catch (e: any) {
      mark('fill', false, undefined, String(e?.message || e));
    }
  };

  useEffect(() => { loadStatusAndSubs(); loadSubaccounts(); }, []);
  useEffect(() => { loadTxSummary(); loadTxHistory(); }, [p.apiBase]);
  useEffect(() => {
    let id: any = null;
    const tick = async () => {
      try {
        const r = await fetch(`${p.apiBase}${ROUTES.drift.infraStatus}`);
        const j = await r.json().catch(() => ({}));
        setInfra(j || null);
      } catch {}
    };
    id = setInterval(tick, 15000);
    tick();
    return () => { try { clearInterval(id); } catch {} };
  }, [p.apiBase]);
  useEffect(() => {
    let id: any = null;
    const tick = async () => { try { await loadTxSummary(); } catch {} };
    id = setInterval(tick, 60000);
    return () => { try { clearInterval(id); } catch {} };
  }, [p.apiBase]);
  useEffect(() => {
    let id: any = null;
    const tick = async () => { try { await loadTxHistory(); } catch {} };
    id = setInterval(tick, 30000);
    return () => { try { clearInterval(id); } catch {} };
  }, [p.apiBase]);

  // Real-time transaction updates via WebSocket
  useEffect(() => {
    const s = ctxSocket;
    if (!s) return;
    const onTx = (evt: any) => {
      try {
        if (!evt || typeof evt !== 'object') return;
        const rec = evt.record;
        if (!rec || !rec.sig) return;
        
        if (evt.type === 'new') {
          // Add new transaction to the beginning of the list
          setTxHistory((prev) => {
            const exists = prev.some((r: any) => r.sig === rec.sig);
            if (exists) return prev;
            return [rec, ...prev].slice(0, 200); // Keep max 200
          });
        } else if (evt.type === 'update') {
          // Update existing transaction
          setTxHistory((prev) => {
            const idx = prev.findIndex((r: any) => r.sig === rec.sig);
            if (idx < 0) return prev;
            const updated = [...prev];
            updated[idx] = { ...updated[idx], ...rec };
            return updated;
          });
        }
      } catch {}
    };
    try { s.on('drift-tx', onTx); } catch {}
    return () => { try { s.off('drift-tx', onTx); } catch {} };
  }, [ctxSocket]);
  useEffect(() => {
    let id: any = null;
    const tick = async () => { try { await checkBotHealth(); } catch {} };
    id = setInterval(tick, 15000);
    tick();
    return () => { try { clearInterval(id); } catch {} };
  }, [p.apiBase]);
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

  useEffect(() => {
    const s = ctxSocket;
    if (!s) return;
    const onLiq = (evt: any) => {
      try {
        if (evt && typeof evt === 'object' && (evt.type === 'queue' || evt.type === 'stats') && Array.isArray(evt.users)) {
          setLiqUsers(evt.users as any);
          return;
        }
        if (evt && typeof evt === 'object' && evt.type === 'user_summary' && evt.summary) {
          const sum = evt.summary as any;
          const key = String(sum.userPk || sum.user || '');
          if (key) {
            setLiqUsers((prev) => {
              try {
                const arr = Array.isArray(prev) ? [...prev] : [] as any[];
                const idx = arr.findIndex((u) => String((u as any).userPk) === key);
                if (idx >= 0) {
                  const u = { ...(arr[idx] as any) };
                  if (typeof sum.health === 'number') u.health = sum.health;
                  if (typeof sum.updatedAt === 'number') u.updatedAt = sum.updatedAt;
                  if (typeof sum.exposureUsd === 'number') (u as any).exposureUsd = sum.exposureUsd;
                  if (typeof sum.collateralUsd === 'number') (u as any).collateralUsd = sum.collateralUsd;
                  if (typeof sum.profitability === 'number') (u as any).profitability = sum.profitability;
                  if (typeof sum.maintenanceUsd === 'number') (u as any).maintenanceUsd = sum.maintenanceUsd;
                  if (typeof sum.freeUsd === 'number') (u as any).freeUsd = sum.freeUsd;
                  if (typeof sum.skipReason === 'string') (u as any).skipReason = sum.skipReason;
                  if (Array.isArray(sum.positions)) (u as any).positions = sum.positions;
                  (arr[idx] as any) = u;
                } else {
                  const u: any = {
                    userPk: key,
                    health: (typeof sum.health === 'number') ? sum.health : 0,
                    updatedAt: (typeof sum.updatedAt === 'number') ? sum.updatedAt : Date.now(),
                  };
                  if (typeof sum.exposureUsd === 'number') u.exposureUsd = sum.exposureUsd;
                  if (typeof sum.collateralUsd === 'number') u.collateralUsd = sum.collateralUsd;
                  if (typeof sum.maintenanceUsd === 'number') u.maintenanceUsd = sum.maintenanceUsd;
                  if (typeof sum.freeUsd === 'number') u.freeUsd = sum.freeUsd;
                  if (typeof sum.profitability === 'number') u.profitability = sum.profitability;
                  if (typeof sum.skipReason === 'string') u.skipReason = sum.skipReason;
                  if (Array.isArray(sum.positions)) u.positions = sum.positions;
                  arr.unshift(u);
                }
                return arr;
              } catch { return prev; }
            });
            setUserDetails((prev) => {
              const cur = { ...(prev || {}) } as any;
              const d = { ...(cur[key] || {}) };
              d.collateral = {
                totalUi: Number(sum.collateralUsd || 0),
                maintUi: Number(sum.maintenanceUsd || 0),
                freeUi: Number(sum.freeUsd || 0),
              };
              cur[key] = d;
              return cur;
            });
          }
          return;
        }
      } catch {}
    };
    try { s.on('drift-liquidation', onLiq); } catch {}
    return () => { try { s.off('drift-liquidation', onLiq); } catch {} };
  }, [ctxSocket]);

  const lsRef = useRef<any[]>([]);
  useEffect(() => {
    lsRef.current = Array.isArray(p.ls) ? p.ls : [];
  }, [p.ls]);

  useEffect(() => {
    let id: any = null;
    const tick = async () => {
      try {
        const ls = lsRef.current;
        const key = (ls.length > 0 && typeof ls[0]?.key === 'string') ? ls[0].key : 'liq#default';
        const res = await fetch(`${p.apiBase}${ROUTES.strategies.liquidator.queue}?key=${encodeURIComponent(key)}&limit=200`);
        const data = await res.json().catch(() => ({}));
        const q = data?.queue;
        if (q && Array.isArray(q.users)) setLiqUsers(q.users);
      } catch {}
    };
    id = setInterval(tick, 10000);
    tick();
    return () => { try { clearInterval(id); } catch {} };
  }, [p.apiBase]);

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

  const testUser = async (userPk: string) => {
    try {
      const key = (Array.isArray(p.ls) && p.ls.length > 0 && typeof p.ls[0]?.key === 'string') ? p.ls[0].key : 'liq#default';
      await fetch(`${p.apiBase}${ROUTES.strategies.liquidator.test || '/strategies/liquidator/test'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, userPk })
      });
    } catch {}
  };

  const [openUser, setOpenUser] = useState<string | null>(null);
  const [userDetails, setUserDetails] = useState<Record<string, any>>({});
  const toggleOpen = async (userPk: string) => {
    try {
      if (openUser === userPk) { setOpenUser(null); return; }
      setOpenUser(userPk);
      if (!userDetails[userPk]) {
        const r = await fetch(`${p.apiBase}/drift/user/${encodeURIComponent(userPk)}`);
        const j = await r.json().catch(() => ({}));
        setUserDetails(prev => ({ ...prev, [userPk]: j }));
      }
    } catch {}
  };

  const [open, setOpen] = useState<{ liq: boolean; trig: boolean; fill: boolean }>({ liq: true, trig: true, fill: true });
  
  const formatAgo = (ts?: number) => {
    if (!ts || !Number.isFinite(Number(ts))) return '-';
    const d = Date.now() - Number(ts);
    if (!Number.isFinite(d)) return '-';
    if (d < 60000) return `${Math.max(0, Math.floor(d / 1000))}s ago`;
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    return `${Math.floor(d / 3600000)}h ago`;
  };
  
  const formatMs = (v: any) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '-';
    return `${Math.round(n)}ms`;
  };
  
  const shortPk = (s: string) => (s && s.length > 10 ? `${s.slice(0, 4)}...${s.slice(-4)}` : (s || '-'));
  
  const txDisplayLimit = 10;
  // Sort by timestamp descending (most recent first) and take first N
  const txDisplay = useMemo(() => {
    const sorted = [...txHistory].sort((a: any, b: any) => Number(b.ts || 0) - Number(a.ts || 0));
    return sorted.slice(0, txDisplayLimit);
  }, [txHistory]);

  // Render infrastructure status badges
  const renderInfraBadges = () => (
    <div className="flex items-center gap-2">
      <StatusBadge
        status={infra?.active ? 'active' : 'inactive'}
        label={infra?.active ? 'Infra: ON' : 'Infra: OFF'}
        title={infra?.forceActive ? 'Force active' : ''}
      />
      {!!infra?.lastSlotAtMs && (
        <StatusBadge
          status={infra?.slotStale ? 'error' : 'ok'}
          label={infra?.slotStale ? 'SLOT STALE' : 'SLOT OK'}
          title={`Last slot at ${new Date(infra.lastSlotAtMs).toLocaleTimeString()}`}
        />
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Stats Panel */}
      <Panel
        title="Stats"
        badges={renderInfraBadges()}
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={loadStatusAndSubs} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </Button>
            <Button onClick={async () => { 
              try { setInfraBusy(true); await fetch(`${p.apiBase}${ROUTES.drift.infraActivate}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await loadStatusAndSubs(); } finally { setInfraBusy(false); } 
            }} disabled={infraBusy}>
              Activate
            </Button>
            <Button onClick={async () => { 
              try { setInfraBusy(true); await fetch(`${p.apiBase}${ROUTES.drift.infraDeactivate}`, { method: 'POST' }); await loadStatusAndSubs(); } finally { setInfraBusy(false); } 
            }} disabled={infraBusy}>
              Deactivate
            </Button>
            {!!p.onOpenExecConfig && (
              <Button onClick={() => p.onOpenExecConfig?.()}>Execution Config</Button>
            )}
          </div>
        }
      >
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Total Users"
            value={(() => {
              const u = infra?.userCount;
              const total = Number(u?.total || 0);
              if (u?.error) return 'unavailable';
              if (!Number.isFinite(total) || total <= 0) return u?.refreshing ? 'loading...' : '-';
              return `${total.toLocaleString()}${u?.capped ? '+' : ''}`;
            })()}
            subValue={formatAgo(Number(infra?.userCount?.updatedAtMs || 0))}
          />
          <StatCard
            label="At-Risk Users"
            value={liqUsers.length.toLocaleString()}
            subValue="queue snapshot"
          />
          <StatCard
            label="Markets"
            value={`${Array.isArray(status?.markets) ? status.markets.length : 0} perp / ${spotMarkets.length} spot`}
            subValue="tracked"
          />
          <StatCard
            label="Bots / Subs"
            value={`${infra?.bots ?? 0} / ${(p.driftSubaccounts || []).length}`}
            subValue={`${(() => {
              const pos = Array.isArray(status?.subaccounts)
                ? status.subaccounts.reduce((s: number, sa: any) => s + (Array.isArray(sa?.positions) ? sa.positions.length : 0), 0)
                : 0;
              return `${pos} positions`;
            })()}`}
          />
        </div>

        {/* Event Index Stats */}
        {infra?.indexStats && (
          <div className="grid grid-cols-3 gap-3 mt-4">
            <StatCard
              label="Indexed Users"
              value={(infra.indexStats.users ?? 0).toLocaleString()}
              subValue="event index"
            />
            <StatCard
              label="Active Markets"
              value={(infra.indexStats.markets ?? 0).toLocaleString()}
              subValue="with activity"
            />
            <StatCard
              label="Tracked Orders"
              value={(infra.indexStats.marketToOrders ?? 0).toLocaleString()}
              subValue="conditional"
            />
          </div>
        )}

        {/* Footer Info */}
        <div className="mt-4 pt-3 border-t border-gray-700 text-xs text-gray-500">
          {status?.cluster ? `Cluster: ${status.cluster}` : null}
          {status?.programId ? ` - Program: ${status.programId}` : null}
        </div>
      </Panel>

      {/* Subaccounts Panel */}
      <Panel
        title="Subaccounts"
        collapsible
        defaultCollapsed
        actions={
          <div className="flex items-center gap-2">
            <Input
              className="w-32"
              placeholder="Name (optional)"
              value={p.driftNewSubName}
              onChange={(e) => p.setDriftNewSubName(e.target.value)}
            />
            <Button variant="primary" onClick={createSub} disabled={p.driftOpBusy}>
              + Create
            </Button>
          </div>
        }
      >
        {error && <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>}

        {/* Subaccount Selection & Deposit/Withdraw */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <InputGroup label="Select Subaccount">
            <div className="flex gap-2">
              <Select
                className="flex-1"
                value={Number.isFinite(Number(p.driftSelectedSubId)) ? Number(p.driftSelectedSubId) : ''}
                onChange={(e) => p.setDriftSelectedSubId(Number(e.target.value))}
              >
                {(p.driftSubaccounts || []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {typeof s.name === 'string' && s.name.length ? `${s.name} (#${s.id})` : `Sub #${s.id}`}
                  </option>
                ))}
              </Select>
              <Button
                onClick={() => switchSub(Number(p.driftSelectedSubId))}
                disabled={p.driftOpBusy || !Number.isFinite(Number(p.driftSelectedSubId))}
              >
                Switch
              </Button>
            </div>
            {selected && (
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-800/50 rounded p-2">
                  <div className="text-xs text-gray-400">Free Collateral</div>
                  <div className="text-white font-mono">{Number(selected.freeCollateral ?? 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-800/50 rounded p-2">
                  <div className="text-xs text-gray-400">Total Collateral</div>
                  <div className="text-white font-mono">{Number(selected.totalCollateral ?? 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-800/50 rounded p-2">
                  <div className="text-xs text-gray-400">Initial Req.</div>
                  <div className="text-white font-mono">{Number(selected.initialRequirement ?? 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-800/50 rounded p-2">
                  <div className="text-xs text-gray-400">Maint. Req.</div>
                  <div className="text-white font-mono">{Number(selected.maintenanceRequirement ?? 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-800/50 rounded p-2 col-span-2">
                  <div className="text-xs text-gray-400">Effective Leverage</div>
                  <div className="text-white font-mono">{Number(selected.effectiveLeverage ?? 0).toFixed(2)}x</div>
                </div>
              </div>
            )}
          </InputGroup>

          <InputGroup label="Deposit / Withdraw">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">Spot Market</div>
                <Select
                  className="w-full"
                  value={spotIndex}
                  onChange={(e) => setSpotIndex(Number(e.target.value))}
                >
                  {(spotMarkets || []).map((m) => (
                    <option key={m.marketIndex} value={m.marketIndex}>
                      {m.symbol ? `${m.symbol} (${m.marketIndex})` : `Market ${m.marketIndex}`}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Amount</div>
                <Input
                  className="w-full"
                  type="number"
                  step="0.000001"
                  value={amount}
                  onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="success" onClick={() => doSubOp('deposit')} disabled={p.driftOpBusy}>
                Deposit
              </Button>
              <Button variant="danger" onClick={() => doSubOp('withdraw')} disabled={p.driftOpBusy}>
                Withdraw
              </Button>
            </div>
          </InputGroup>
        </div>

        {/* Balances Table */}
        <div className="mt-6">
          <h4 className="text-sm font-medium text-gray-300 mb-3">
            Balances{Number.isFinite(Number(p.driftSelectedSubId)) ? ` - Sub #${p.driftSelectedSubId}` : ''}
          </h4>
          <DataTable headers={['Mint', 'Symbol', 'Amount']} compact>
            {balances.length > 0 ? balances.map((b, i) => (
              <DataTableRow key={i}>
                <DataTableCell compact mono className="text-xs">{b.mint || '-'}</DataTableCell>
                <DataTableCell compact>{b.symbol || '-'}</DataTableCell>
                <DataTableCell compact mono>{Number(b.amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 9 })}</DataTableCell>
              </DataTableRow>
            )) : (
              <tr><td colSpan={3}><EmptyState message="No balances" /></td></tr>
            )}
          </DataTable>
        </div>
      </Panel>

      {/* Liquidators Panel */}
      <Panel
        title="Liquidators"
        collapsible
        defaultCollapsed={!open.liq}
        badges={<StatusBadge status={botHealth.liq?.ok ? 'ok' : 'error'} label={botHealth.liq?.ok ? 'API OK' : 'API ERR'} />}
        actions={
          <div className="flex items-center gap-2">
            {!!p.onOpenLiqRunner && (
              <Button variant="primary" onClick={() => p.onOpenLiqRunner?.()}>+ New Liquidator</Button>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <LiquidatorStatus apiBase={p.apiBase} hideHeader />
          <div className="grid grid-cols-1 gap-3">
            {p.ls.map((x) => (
              <LiquidationMonitor key={x.key} apiBase={p.apiBase} liquidatorKey={x.key} hideUserList />
            ))}
          </div>

          {/* Users Table */}
          <div>
            <h4 className="text-sm font-medium text-gray-300 mb-3">Users Under Threshold</h4>
            <div className="text-xs text-gray-500 mb-2">Health is (total - maintenance) / maintenance; 0 = liquidation. Thresholds use ratios (0.4 = 40%).</div>
            <DataTable 
              headers={['User', 'Health', 'Updated', 'Exposure', 'C/E', 'Est. Profit', 'Skip', 'Actions']} 
              compact
            >
              {liqUsers.length > 0 ? liqUsers.map((u) => (
                <React.Fragment key={u.userPk}>
                  <DataTableRow onClick={() => toggleOpen(u.userPk)}>
                    <DataTableCell compact mono className="text-xs">{shortPk(u.userPk)}</DataTableCell>
                    <DataTableCell compact className={u.health < -0.5 ? 'text-red-400' : u.health < 0 ? 'text-yellow-400' : ''}>
                      {(u.health * 100).toFixed(2)}%
                    </DataTableCell>
                    <DataTableCell compact className="text-gray-500 text-xs">{formatAgo(u.updatedAt)}</DataTableCell>
                    <DataTableCell compact mono>
                      {(() => {
                        const ex = (u as any).exposureUsd;
                        if (typeof ex === 'number') return `$${ex.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
                        let sum = 0;
                        try { if (Array.isArray((u as any).positions)) for (const pos of (u as any).positions) { if (typeof (pos as any).notional === 'number') sum += Math.abs((pos as any).notional as number); } } catch {}
                        return sum > 0 ? `$${sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-';
                      })()}
                    </DataTableCell>
                    <DataTableCell compact>
                      {(() => {
                        const c = (u as any).collateralUsd;
                        let ex = (u as any).exposureUsd;
                        if (!(typeof ex === 'number')) {
                          let sum = 0;
                          try { if (Array.isArray((u as any).positions)) for (const pos of (u as any).positions) { if (typeof (pos as any).notional === 'number') sum += Math.abs((pos as any).notional as number); } } catch {}
                          ex = sum;
                        }
                        return (typeof c === 'number' && typeof ex === 'number' && ex > 0) ? (c / ex).toFixed(2) : '-';
                      })()}
                    </DataTableCell>
                    <DataTableCell compact>
                      {(() => {
                        let prof = (u as any).profitability;
                        if (typeof prof !== 'number' && Array.isArray((u as any).positions)) {
                          for (const pos of (u as any).positions) {
                            if (typeof (pos as any).profitability === 'number') {
                              prof = (typeof prof === 'number') ? Math.min(prof as number, (pos as any).profitability as number) : (pos as any).profitability;
                            }
                          }
                        }
                        return (typeof prof === 'number') ? (
                          <span className={`font-mono ${(prof as number) > 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                            {((prof as number) * 100).toFixed(2)}%
                          </span>
                        ) : <span className="text-gray-500">-</span>;
                      })()}
                    </DataTableCell>
                    <DataTableCell compact>
                      {typeof (u as any).skipReason === 'string' && (u as any).skipReason ? (
                        <span className="px-1.5 py-0.5 bg-gray-700 rounded text-[10px] uppercase tracking-wide">
                          {(u as any).skipReason}
                        </span>
                      ) : <span className="text-gray-500">-</span>}
                    </DataTableCell>
                    <DataTableCell compact>
                      <div className="flex gap-2">
                        <Button size="xs" onClick={(e) => { e?.stopPropagation(); toggleOpen(u.userPk); }}>
                          {openUser === u.userPk ? 'Hide' : 'Show'}
                        </Button>
                        <Button size="xs" variant="primary" onClick={(e) => { e?.stopPropagation(); testUser(u.userPk); }}>
                          Test
                        </Button>
                      </div>
                    </DataTableCell>
                  </DataTableRow>
                  {openUser === u.userPk && (
                    <tr className="bg-gray-900/60">
                      <td colSpan={8} className="p-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                          <StatCard label="Total" value={Number(userDetails[u.userPk]?.collateral?.totalUi || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                          <StatCard label="Maintenance" value={Number(userDetails[u.userPk]?.collateral?.maintUi || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                          <StatCard label="Free" value={Number(userDetails[u.userPk]?.collateral?.freeUi || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <h5 className="text-sm font-medium text-gray-300 mb-2">Spot Collateral - Deposits</h5>
                            <DataTable headers={['Market', 'Mint', 'Amount']} compact>
                              {(userDetails[u.userPk]?.spotCollateral || []).filter((c: any) => Number(c?.amountUi || 0) > 0).length > 0 ? 
                                (userDetails[u.userPk]?.spotCollateral || []).filter((c: any) => Number(c?.amountUi || 0) > 0).map((c: any, i: number) => (
                                  <DataTableRow key={i}>
                                    <DataTableCell compact>{c.symbol || c.marketIndex}</DataTableCell>
                                    <DataTableCell compact mono className="text-xs">{c.mint || '-'}</DataTableCell>
                                    <DataTableCell compact mono className="text-green-400">
                                      {Number(c.amountUi || 0).toLocaleString(undefined, { maximumFractionDigits: 9 })}
                                    </DataTableCell>
                                  </DataTableRow>
                                )) : <tr><td colSpan={3}><EmptyState message="No deposits" /></td></tr>}
                            </DataTable>
                            
                            <h5 className="text-sm font-medium text-gray-300 mb-2 mt-4">Spot Collateral - Borrows</h5>
                            <DataTable headers={['Market', 'Mint', 'Amount']} compact>
                              {(userDetails[u.userPk]?.spotCollateral || []).filter((c: any) => Number(c?.amountUi || 0) < 0).length > 0 ? 
                                (userDetails[u.userPk]?.spotCollateral || []).filter((c: any) => Number(c?.amountUi || 0) < 0).map((c: any, i: number) => (
                                  <DataTableRow key={i}>
                                    <DataTableCell compact>{c.symbol || c.marketIndex}</DataTableCell>
                                    <DataTableCell compact mono className="text-xs">{c.mint || '-'}</DataTableCell>
                                    <DataTableCell compact mono className="text-red-400">
                                      {Math.abs(Number(c.amountUi || 0)).toLocaleString(undefined, { maximumFractionDigits: 9 })}
                                    </DataTableCell>
                                  </DataTableRow>
                                )) : <tr><td colSpan={3}><EmptyState message="No borrows" /></td></tr>}
                            </DataTable>
                          </div>
                          <div>
                            <h5 className="text-sm font-medium text-gray-300 mb-2">Perp Positions (Est.)</h5>
                            <DataTable headers={['Market', 'Base', 'Notional', 'Liq', 'Prof']} compact>
                              {Array.isArray((u as any).positions) && (u as any).positions.length > 0 ? 
                                (u as any).positions.map((pp: any, i: number) => (
                                  <DataTableRow key={i}>
                                    <DataTableCell compact>{pp.symbol || pp.marketIndex}</DataTableCell>
                                    <DataTableCell compact mono>{Number(pp.base ?? 0).toFixed(3)}</DataTableCell>
                                    <DataTableCell compact mono>{typeof pp.notional === 'number' ? `$${Number(pp.notional).toFixed(2)}` : '-'}</DataTableCell>
                                    <DataTableCell compact mono>{typeof pp.liqPrice === 'number' ? Number(pp.liqPrice).toFixed(2) : '-'}</DataTableCell>
                                    <DataTableCell compact>
                                      {typeof pp.profitability === 'number' ? (
                                        <span className={`font-mono ${(pp.profitability as number) > 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                                          {((pp.profitability as number) * 100).toFixed(2)}%
                                        </span>
                                      ) : <span className="text-gray-500">-</span>}
                                    </DataTableCell>
                                  </DataTableRow>
                                )) : <tr><td colSpan={5}><EmptyState message="No estimated perp positions" /></td></tr>}
                            </DataTable>
                            
                            <h5 className="text-sm font-medium text-gray-300 mb-2 mt-4">Perp Positions (Raw)</h5>
                            <DataTable headers={['Market', 'Base (raw)']} compact>
                              {(userDetails[u.userPk]?.perpPositions || []).length > 0 ? 
                                (userDetails[u.userPk]?.perpPositions || []).map((pp: any, i: number) => (
                                  <DataTableRow key={i}>
                                    <DataTableCell compact>{pp.marketIndex}</DataTableCell>
                                    <DataTableCell compact mono>{Number(pp.baseRaw || 0).toLocaleString()}</DataTableCell>
                                  </DataTableRow>
                                )) : <tr><td colSpan={2}><EmptyState message="No raw perp positions" /></td></tr>}
                            </DataTable>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )) : (
                <tr><td colSpan={8}><EmptyState message="No users under threshold" /></td></tr>
              )}
            </DataTable>
          </div>
        </div>
      </Panel>

      {/* Triggers & Fillers - Side by Side on Large Screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Triggers Panel */}
        <Panel
          title="Triggers"
          collapsible
          defaultCollapsed={!open.trig}
          badges={<StatusBadge status={botHealth.trig?.ok ? 'ok' : 'error'} label={botHealth.trig?.ok ? 'API OK' : 'API ERR'} />}
          actions={
            !!p.onOpenTriggerRunner && (
              <Button variant="warning" onClick={() => p.onOpenTriggerRunner?.()}>+ New Trigger Bot</Button>
            )
          }
        >
          <TriggerStatus apiBase={p.apiBase} hideHeader />
        </Panel>

        {/* Fillers Panel */}
        <Panel
          title="Fillers"
          collapsible
          defaultCollapsed={!open.fill}
          badges={<StatusBadge status={botHealth.fill?.ok ? 'ok' : 'error'} label={botHealth.fill?.ok ? 'API OK' : 'API ERR'} />}
          actions={
            !!p.onOpenFillerRunner && (
              <Button variant="primary" onClick={() => p.onOpenFillerRunner?.()}>+ New Filler Bot</Button>
            )
          }
        >
          <FillerStatus apiBase={p.apiBase} hideHeader />
        </Panel>
      </div>

      {/* Transactions Panel */}
      <Panel
        title="Transactions"
        collapsible
        defaultCollapsed
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">Showing last {txDisplayLimit}</span>
            <Button onClick={loadTxHistory} disabled={txBusy}>
              {txBusy ? 'Loading...' : 'Refresh'}
            </Button>
          </div>
        }
      >
        <DataTable
          headers={['Time', 'Action', 'Bot', 'Market', 'User', 'Cost (SOL)', 'Revenue (q)', 'Build/Send/Confirm', 'Status', 'Tx']}
          compact
        >
          {txDisplay.length > 0 ? txDisplay.map((row: any, i: number) => {
            const sig = String(row?.sig || '');
            const cluster = String(status?.cluster || 'mainnet-beta');
            const clusterQs = cluster === 'devnet' ? '?cluster=devnet' : (cluster === 'localnet' ? '?cluster=localnet' : '');
            const solscan = sig && sig !== 'FAILED' ? `https://solscan.io/tx/${sig}${clusterQs}` : null;
            const st = row?.status || null;
            const conf = st?.confirmationStatus || '';
            const err = st?.err ? 'err' : '';
            const statusLabel = err ? 'error' : (conf || (row?.success ? 'confirmed' : 'unknown'));
            return (
              <DataTableRow key={`${sig}-${i}`}>
                <DataTableCell compact>{row?.ts ? new Date(Number(row.ts)).toLocaleTimeString() : '-'}</DataTableCell>
                <DataTableCell compact className="uppercase">{row?.action || '-'}</DataTableCell>
                <DataTableCell compact>{row?.bot || '-'}</DataTableCell>
                <DataTableCell compact>{Number.isFinite(Number(row?.marketIndex)) ? row.marketIndex : '-'}</DataTableCell>
                <DataTableCell compact mono className="text-xs">
                  {row?.taker ? (
                    <a 
                      className="text-blue-400 hover:underline" 
                      href={`https://solscan.io/account/${row.taker}${clusterQs}`} 
                      target="_blank" 
                      rel="noreferrer"
                      title={row.taker}
                    >
                      {shortPk(String(row.taker))}
                    </a>
                  ) : '-'}
                </DataTableCell>
                <DataTableCell compact mono>{Number(row?.lamportsPaid ?? 0) / 1_000_000_000}</DataTableCell>
                <DataTableCell compact mono>{Number(row?.fillerRewardQuote ?? 0) ? Number(row?.fillerRewardQuote ?? 0).toLocaleString() : '-'}</DataTableCell>
                <DataTableCell compact mono>{formatMs(row?.buildMs)} / {formatMs(row?.sendMs)} / {formatMs(row?.confirmMs)}</DataTableCell>
                <DataTableCell compact className={err ? 'text-red-400' : ''}>{statusLabel}</DataTableCell>
                <DataTableCell compact>
                  {solscan ? (
                    <a className="text-blue-400 hover:underline" href={solscan} target="_blank" rel="noreferrer">solscan</a>
                  ) : (
                    <span className="text-gray-500">-</span>
                  )}
                </DataTableCell>
              </DataTableRow>
            );
          }) : (
            <tr><td colSpan={10}><EmptyState message="No transactions" /></td></tr>
          )}
        </DataTable>
      </Panel>

      {/* Performance Summary Panel */}
      <Panel
        title="Performance Summary"
        collapsible
        defaultCollapsed
        actions={<Button onClick={loadTxSummary}>Refresh</Button>}
      >
        <DataTable
          headers={['Window', 'Action', 'Attempts', 'Success', 'Cost (SOL)', 'Revenue (q)', 'Build p50/p95', 'Send p50/p95', 'Confirm p50/p95']}
          compact
        >
          {txSummary ? (
            (['1h', '24h'] as const).flatMap((win) =>
              (['all', 'fill', 'trigger', 'liquidate'] as const).map((action) => {
                const m = txSummary?.[win]?.[action];
                const attempts = Number(m?.attempts ?? 0);
                const successes = Number(m?.successes ?? 0);
                const successRate = attempts > 0 ? ((successes / attempts) * 100).toFixed(1) : '0.0';
                const costSol = Number(m?.costSol ?? 0);
                const revenue = Number(m?.revenueQuote ?? 0);
                return (
                  <DataTableRow key={`${win}-${action}`}>
                    <DataTableCell compact>{win}</DataTableCell>
                    <DataTableCell compact className="uppercase">{action}</DataTableCell>
                    <DataTableCell compact mono>{attempts}</DataTableCell>
                    <DataTableCell compact mono>{successRate}%</DataTableCell>
                    <DataTableCell compact mono>{costSol.toFixed(4)}</DataTableCell>
                    <DataTableCell compact mono>{action === 'fill' || action === 'all' ? revenue.toLocaleString() : '-'}</DataTableCell>
                    <DataTableCell compact mono>{formatMs(m?.timings?.buildMs?.p50)} / {formatMs(m?.timings?.buildMs?.p95)}</DataTableCell>
                    <DataTableCell compact mono>{formatMs(m?.timings?.sendMs?.p50)} / {formatMs(m?.timings?.sendMs?.p95)}</DataTableCell>
                    <DataTableCell compact mono>{formatMs(m?.timings?.confirmMs?.p50)} / {formatMs(m?.timings?.confirmMs?.p95)}</DataTableCell>
                  </DataTableRow>
                );
              })
            )
          ) : (
            <tr><td colSpan={9}><EmptyState message="No summary data" /></td></tr>
          )}
        </DataTable>
      </Panel>
    </div>
  );
};
