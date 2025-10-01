import React, { useEffect, useMemo, useRef, useState } from 'react';
// @ts-ignore - types may be missing in some environments
import CytoscapeComponent from 'react-cytoscapejs';
import cytoscape, { ElementDefinition } from 'cytoscape';
import type { NodeSingular, EdgeSingular } from 'cytoscape';
// @ts-ignore - types may be missing in some environments
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

type GraphSnapshot = {
  version: number;
  timestamp: number;
  nodes: Array<{ id: string; label?: string; degree?: number }>;
  edges: Array<{ id: string; source: string; target: string; dex: string; fee_bps?: number; liquidity?: number; liquidity_display?: number; weight?: number; price_a_per_b?: number; tvl_usd?: number; pool_id?: string; source_account?: string; target_account?: string; pool_kind?: 'amm'|'clmm'; direction?: 'forward'|'reverse'; pool_liquidity_raw?: number }>;
};

type GraphDiff = {
  version: number;
  timestamp: number;
  addedNodes: GraphSnapshot['nodes'];
  updatedNodes: GraphSnapshot['nodes'];
  removedNodeIds: string[];
  addedEdges: GraphSnapshot['edges'];
  updatedEdges: GraphSnapshot['edges'];
  removedEdgeIds: string[];
};

export const GraphView: React.FC<{ apiBase: string; socket?: any; square?: boolean }> = ({ apiBase, socket, square }) => {
  const cyRef = useRef<cytoscape.Core | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
	const [layoutName, setLayoutName] = useState<'fcose' | 'cose' | 'grid' | 'circle'>('circle');
	const [filterDex, setFilterDex] = useState<{ Raydium: boolean; Orca: boolean }>({ Raydium: true, Orca: true });
	const [filterKind, setFilterKind] = useState<{ AMM: boolean; CLMM: boolean }>({ AMM: true, CLMM: true });
  const laidOutRef = useRef(false);
	const forceLayoutRef = useRef(false);
  const [selection, setSelection] = useState<
    | { kind: 'node'; id: string; label?: string; degree?: number; neighbors?: number }
    | { kind: 'edge'; id: string; source: string; target: string; dex: string; fee_bps?: number; liquidity?: number; weight?: number; price_a_per_b?: number; tvl_usd?: number; pool_id?: string; source_account?: string; target_account?: string }
    | null
  >(null);

	const styles: any[] = useMemo(() => ([
		{ selector: 'node', style: { 'background-color': '#3b82f6', 'label': 'data(label)', 'font-size': 8, 'color': '#e5e7eb', 'text-outline-width': 1, 'text-outline-color': '#111827' } },
		{
			selector: 'edge',
			style: {
				'width': 1.5,
				'line-color': '#6b7280',
				'opacity': 0.8,
				'curve-style': 'bezier',
				'edge-distances': 'node-position',
				// Per-edge offset for fanning parallel edges
				'control-point-distance': 'data(cpd)'
			}
		},
		{ selector: 'edge[dex = "Raydium"]', style: { 'line-color': '#22c55e' } },
		{ selector: 'edge[dex = "Orca"]', style: { 'line-color': '#f59e0b' } },
		{ selector: 'edge.highlighted', style: { 'line-color': '#ef4444', 'width': 3.5, 'opacity': 1 } },
		{ selector: ':selected', style: { 'line-color': '#ef4444', 'background-color': '#ef4444' } },
	]), []);

	const toElements = (snap: GraphSnapshot): ElementDefinition[] => {
    const hideDex = new Set<string>();
    if (!filterDex.Raydium) hideDex.add('Raydium');
    if (!filterDex.Orca) hideDex.add('Orca');
		const hideKind = new Set<string>();
		if (!filterKind.AMM) hideKind.add('amm');
		if (!filterKind.CLMM) hideKind.add('clmm');
		const nodes: ElementDefinition[] = snap.nodes.map((n) => ({ data: { id: n.id, label: n.label || n.id.slice(0, 4) } }));
		const edges: ElementDefinition[] = snap.edges
			.filter((e) => !hideDex.has(e.dex))
			.filter((e) => {
				const kind = (e as any).pool_kind;
				return kind === 'amm' || kind === 'clmm' ? !hideKind.has(kind) : true;
			})
			.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, dex: e.dex, fee_bps: e.fee_bps, liquidity: e.liquidity, liquidity_display: (e as any).liquidity_display, weight: e.weight, price_a_per_b: (e as any).price_a_per_b, tvl_usd: (e as any).tvl_usd, pool_id: (e as any).pool_id, source_account: (e as any).source_account, target_account: (e as any).target_account, pool_kind: (e as any).pool_kind, direction: (e as any).direction, pool_liquidity_raw: (e as any).pool_liquidity_raw, cpd: 0 } }));
		// Assign per-pair control-point distances to fan out parallel edges
		const group = new Map<string, ElementDefinition[]>();
		for (const ed of edges) {
			const a = String((ed.data as any).source);
			const b = String((ed.data as any).target);
			const key = a < b ? `${a}|${b}` : `${b}|${a}`;
			const arr = group.get(key) || [];
			arr.push(ed);
			group.set(key, arr);
		}
		for (const [, arr] of group) {
			arr.sort((x, y) => String((x.data as any).id).localeCompare(String((y.data as any).id)));
			const count = arr.length;
			if (count <= 1) continue;
			const step = 24;
			for (let i = 0; i < count; i++) {
				const k = i - (count - 1) / 2;
				(arr[i].data as any).cpd = Math.round(k * step);
			}
		}
		return [...nodes, ...edges];
  };

	// Recompute control-point distances to fan out parallel edges between two nodes
	const recomputeParallelOffsets = (cy: cytoscape.Core, a: string, b: string, step: number = 24) => {
		try {
			const sel = cy.$(`edge[source = "${a}"][target = "${b}"], edge[source = "${b}"][target = "${a}"]`);
			const arr = sel ? sel.toArray() : [];
			if (!arr.length) return;
			arr.sort((x, y) => String(x.id()).localeCompare(String(y.id())));
			const count = arr.length;
			if (count <= 1) { arr[0] && arr[0].data('cpd', 0); return; }
			for (let i = 0; i < count; i++) {
				const k = i - (count - 1) / 2;
				arr[i].data('cpd', Math.round(k * step));
			}
		} catch {}
	};

	type FitMode = 'never' | 'first' | 'always';
	const runLayout = (fitMode: FitMode = 'first') => {
    const cy = cyRef.current; if (!cy) return;
    const name = layoutName;
		const shouldFit = fitMode === 'always' || (fitMode === 'first' && !laidOutRef.current);
		// If there are no nodes yet, defer layout until we have content
		if (cy.nodes().length === 0) return;
    const options: any = name === 'fcose'
			? { name: 'fcose', animate: false, fit: false, quality: 'default', randomize: true, nodeSeparation: 75, nodeRepulsion: 4500 }
			: { name, animate: false, fit: false };
		const layout = cy.layout(options);
		if (shouldFit) {
			try { cy.one('layoutstop', () => { try { cy.fit(undefined, 20); } catch {} }); } catch {}
		}
		layout.run();
    cy.resize();
    laidOutRef.current = true;
  };

  const refitAndResize = () => {
    const cy = cyRef.current; if (!cy) return;
    cy.resize();
    try { cy.fit(undefined, 20); } catch {}
  };

  // Apply edge highlighting given edge ids and/or (source,target,dex) pairs
  const applyHighlight = (payload: { edgeIds?: string[]; pairs?: Array<{ source: string; target: string; dex?: string }> }) => {
    try {
      const cy = cyRef.current; if (!cy) return;
      const ids = (payload?.edgeIds || []).filter(Boolean);
      const pairs = Array.isArray(payload?.pairs) ? payload?.pairs : [];
      if (!ids.length && !pairs.length) return;
      // Clear previous highlight
      cy.edges().removeClass('highlighted');
      // Match by ids (including reverse suffix) and by (source,target,dex) pairs
      const allIds: string[] = [];
      for (const id of ids) { allIds.push(id, `${id}-rev`); }
      const idSelector = allIds.length ? allIds.map((id) => `#${id}`).join(',') : '';
      const pairSelectors: string[] = [];
      for (const p of pairs) {
        const src = String(p.source);
        const dst = String(p.target);
        const dex = p.dex ? String(p.dex) : '';
        const dexSel = dex ? `[dex = "${dex}"]` : '';
        pairSelectors.push(`edge[source = "${src}"][target = "${dst}"]${dexSel}`);
      }
      const selector = [idSelector, ...pairSelectors].filter(Boolean).join(',');
      const sel = selector ? cy.$(selector) : cy.collection();
      sel.addClass('highlighted');
      // Optionally focus view on highlighted selection
      try { if (sel && sel.length) { cy.fit(sel, 40); } } catch {}
    } catch {}
  };

  const loadSnapshot = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${apiBase}/graph`);
      const j: GraphSnapshot = await r.json();
      const cy = cyRef.current; if (!cy) return;
      cy.elements().remove();
			cy.add(toElements(j));
			// Fan out parallel edges across the entire graph after adding
			try {
				const pairs = new Set<string>();
				cy.edges().forEach((e) => {
					const s = String(e.data('source'));
					const t = String(e.data('target'));
					const key = s < t ? `${s}|${t}` : `${t}|${s}`;
					pairs.add(key);
				});
				pairs.forEach((key) => {
					const [a, b] = key.split('|');
					recomputeParallelOffsets(cy, a, b);
				});
			} catch {}
			// Run layout on first load or when a forced layout is requested (e.g., filter change)
			if (!laidOutRef.current || forceLayoutRef.current) {
				const attemptLayout = () => {
					const el = containerRef.current;
					const w = (el?.clientWidth || 0);
					const h = (el?.clientHeight || 0);
					cy.resize();
					if (w > 0 && h > 0) {
						runLayout(forceLayoutRef.current ? 'always' : 'first');
						forceLayoutRef.current = false;
					} else {
						requestAnimationFrame(attemptLayout);
					}
				};
				requestAnimationFrame(attemptLayout);
			}
      // Do not periodically refit; keep current viewport
      setSelection(null);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSnapshot(); }, [apiBase]);
  useEffect(() => { /* no periodic fit when layout changes to avoid jarring refits */ runLayout('never'); }, [layoutName]);
	useEffect(() => {
		// Changing filters can drastically change geometry; request a fresh layout
		forceLayoutRef.current = true;
		loadSnapshot();
	}, [filterDex.Raydium, filterDex.Orca, filterKind.AMM, filterKind.CLMM]);

  // Listen for external refresh requests (e.g., from ArbitragePanel)
  useEffect(() => {
    const onRefresh = () => { loadSnapshot(); };
    window.addEventListener('graph-refresh' as any, onRefresh as any);
    return () => { try { window.removeEventListener('graph-refresh' as any, onRefresh as any); } catch {} };
  }, []);

  // Support local window event to highlight without server round-trip
  useEffect(() => {
    const handler = (evt: any) => { try { applyHighlight((evt?.detail || {}) as any); } catch {} };
    window.addEventListener('graph-highlight' as any, handler as any);
    return () => { try { window.removeEventListener('graph-highlight' as any, handler as any); } catch {} };
  }, []);

  useEffect(() => {
    // Handle container size changes and window resizes (including browser zoom) to keep renderer in sync
    const cy = cyRef.current;
    const el = containerRef.current;
    if (!cy || !el) return;
    let lastW = 0, lastH = 0;
    const RO: any = (window as any).ResizeObserver;
    const ro = RO ? new RO((entries: any[]) => {
      const entry = entries?.[0];
      const cr = entry?.contentRect || el.getBoundingClientRect();
      const w = Math.floor(cr.width);
      const h = Math.floor(cr.height);
      if (w !== lastW || h !== lastH) {
        lastW = w; lastH = h;
        cy.resize();
      }
    }) : null;
    if (ro) ro.observe(el);
    const onWinResize = () => { cy.resize(); };
    window.addEventListener('resize', onWinResize);
    return () => {
      window.removeEventListener('resize', onWinResize);
      try { ro && ro.disconnect(); } catch {}
    };
  }, [containerRef.current]);

  useEffect(() => {
    if (!socket) return;
		const onDiff = (diff: GraphDiff) => {
      const cy = cyRef.current; if (!cy) return;
      // Apply removals first
      if (diff.removedEdgeIds?.length) cy.remove(diff.removedEdgeIds.map((id) => `#${id}`).join(','));
      if (diff.removedNodeIds?.length) cy.remove(diff.removedNodeIds.map((id) => `#${id}`).join(','));
      // Apply adds/updates respecting filters
      const hideDex = new Set<string>();
      if (!filterDex.Raydium) hideDex.add('Raydium');
      if (!filterDex.Orca) hideDex.add('Orca');
			const hideKind = new Set<string>();
			if (!filterKind.AMM) hideKind.add('amm');
			if (!filterKind.CLMM) hideKind.add('clmm');
      const upserts: ElementDefinition[] = [];
      for (const n of [...(diff.addedNodes||[]), ...(diff.updatedNodes||[])]) {
        upserts.push({ data: { id: n.id, label: n.label || n.id.slice(0,4) } });
      }
      for (const e of [...(diff.addedEdges||[]), ...(diff.updatedEdges||[])]) {
				if (hideDex.has(e.dex)) continue;
				const kind = (e as any).pool_kind;
				if (kind === 'amm' || kind === 'clmm') {
					if (hideKind.has(kind)) continue;
				}
        upserts.push({ data: { id: e.id, source: e.source, target: e.target, dex: e.dex, fee_bps: e.fee_bps, liquidity: e.liquidity, liquidity_display: (e as any).liquidity_display, weight: e.weight, price_a_per_b: (e as any).price_a_per_b, tvl_usd: (e as any).tvl_usd, pool_id: (e as any).pool_id, source_account: (e as any).source_account, target_account: (e as any).target_account, pool_kind: (e as any).pool_kind, direction: (e as any).direction, pool_liquidity_raw: (e as any).pool_liquidity_raw } });
      }
			cy.add(upserts);
			// Recompute offsets for affected pairs only
			try {
				const touched = new Set<string>();
				for (const e of [...(diff.addedEdges||[]), ...(diff.updatedEdges||[])]) {
					const s = String(e.source);
					const t = String(e.target);
					const key = s < t ? `${s}|${t}` : `${t}|${s}`;
					touched.add(key);
				}
				touched.forEach((key) => {
					const [a, b] = key.split('|');
					recomputeParallelOffsets(cy, a, b);
				});
			} catch {}
      // Do not re-run layout on incremental diffs to avoid jarring refits
    };
    const onSnapshot = (snap: GraphSnapshot) => {
      const cy = cyRef.current; if (!cy) return;
      cy.elements().remove();
			cy.add(toElements(snap));
			// Run initial layout once on the first snapshot when container is sized
			if (!laidOutRef.current || forceLayoutRef.current) {
				const attemptLayout = () => {
					const el = containerRef.current;
					const w = (el?.clientWidth || 0);
					const h = (el?.clientHeight || 0);
					cy.resize();
					if (w > 0 && h > 0) {
						runLayout(forceLayoutRef.current ? 'always' : 'first');
						forceLayoutRef.current = false;
					} else {
						requestAnimationFrame(attemptLayout);
					}
				};
				requestAnimationFrame(attemptLayout);
			}
			// Keep existing viewport; do not re-run layout on later snapshots
      setSelection(null);
    };
    const onHighlight = (payload: { edgeIds?: string[] }) => { applyHighlight(payload); };
    socket.on('graph-update', onDiff);
    socket.on('graph-snapshot', onSnapshot);
    socket.on('graph-highlight', onHighlight);
    return () => {
      socket.off('graph-update', onDiff);
      socket.off('graph-snapshot', onSnapshot);
      socket.off('graph-highlight', onHighlight);
    };
  }, [socket, filterDex.Raydium, filterDex.Orca, layoutName]);

  // Initialize cy configuration when instance is available
	const onCyReady = (cy: cytoscape.Core) => {
    cyRef.current = cy;
    // Clamp zoom range to avoid pathological scales where elements appear too small
    try { cy.minZoom(0.02); cy.maxZoom(8); } catch {}
		// Ensure user can pan/zoom freely
		try { cy.userZoomingEnabled(true); cy.panningEnabled(true); } catch {}
    // Force an initial resize to ensure correct viewport
    cy.resize();
		// Do not auto-fit here; initial layout will handle a single fit once when size is ready

    // Selection handling
    cy.on('tap', 'node', (evt) => {
      const n = evt.target as NodeSingular;
      const id = n.id();
      const label = n.data('label');
      let degree = 0, neighbors = 0;
      try {
        degree = n.connectedEdges().length;
        neighbors = n.neighborhood('node').length;
      } catch {}
      setSelection({ kind: 'node', id, label, degree, neighbors });
    });
    cy.on('tap', 'edge', (evt) => {
      const e = evt.target as EdgeSingular;
      setSelection({
        kind: 'edge',
        id: e.id(),
        source: e.data('source'),
        target: e.data('target'),
        dex: e.data('dex'),
        fee_bps: e.data('fee_bps'),
        liquidity: e.data('liquidity'),
        weight: e.data('weight'),
        price_a_per_b: e.data('price_a_per_b'),
        tvl_usd: e.data('tvl_usd'),
        pool_id: e.data('pool_id'),
        source_account: e.data('source_account'),
        target_account: e.data('target_account'),
        // extras
        ...(e.data('pool_kind') ? { pool_kind: e.data('pool_kind') } : {}),
        ...(e.data('direction') ? { direction: e.data('direction') } : {}),
        ...(e.data('pool_liquidity_raw') != null ? { pool_liquidity_raw: e.data('pool_liquidity_raw') } : {}),
      });
    });
    cy.on('tap', (evt) => {
      // Clear selection if user taps on background
      if (evt.target === cy) setSelection(null);
    });
  };

  const containerClass = square ? 'aspect-square' : 'h-[360px]';
  return (
    <div className={`p-2 border rounded bg-white/5 ${containerClass} relative`}>
		<div className="absolute top-2 left-2 right-2 z-10 space-y-2 pointer-events-none">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2 pointer-events-auto">
            <h3 className="text-lg font-semibold">Graph</h3>
            <select className="bg-black/30 border rounded px-2 py-1 text-sm" value={layoutName} onChange={(e) => setLayoutName(e.target.value as any)}>
              <option value="fcose">fcose</option>
              <option value="cose">cose</option>
              <option value="grid">grid</option>
              <option value="circle">circle</option>
            </select>
            <label className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={filterDex.Raydium} onChange={(e) => setFilterDex((p) => ({ ...p, Raydium: e.target.checked }))} /> Raydium
            </label>
            <label className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={filterDex.Orca} onChange={(e) => setFilterDex((p) => ({ ...p, Orca: e.target.checked }))} /> Orca
            </label>
					<label className="text-sm flex items-center gap-1">
						<input type="checkbox" checked={filterKind.AMM} onChange={(e) => setFilterKind((p) => ({ ...p, AMM: e.target.checked }))} /> AMM
					</label>
					<label className="text-sm flex items-center gap-1">
						<input type="checkbox" checked={filterKind.CLMM} onChange={(e) => setFilterKind((p) => ({ ...p, CLMM: e.target.checked }))} /> CLMM
					</label>
            <button className="px-2 py-1 border rounded text-sm" onClick={loadSnapshot} disabled={loading}>Refresh Graph</button>
            <button className="px-2 py-1 border rounded text-sm" onClick={refitAndResize}>Refit & Resize</button>
          </div>
				{error ? <div className="text-red-400 text-xs pointer-events-auto">{error}</div> : null}
        </div>
			{selection ? (
				<div className="max-w-md text-xs pointer-events-auto">
            <div className="bg-black/60 text-gray-100 border border-white/10 rounded shadow-lg backdrop-blur p-2">
              <div className="flex items-center justify-between mb-1">
                <div className="font-semibold">{selection.kind === 'node' ? 'Node' : 'Edge'} details</div>
                <button className="px-1 py-0.5 text-xs border rounded" onClick={() => setSelection(null)}>Close</button>
              </div>
              {selection.kind === 'node' ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="opacity-70">ID</div><div className="truncate" title={selection.id}>{selection.id}</div>
                  <div className="opacity-70">Label</div><div className="truncate" title={selection.label || ''}>{selection.label || '—'}</div>
                  <div className="opacity-70">Degree</div><div>{selection.degree ?? '—'}</div>
                  <div className="opacity-70">Neighbors</div><div>{selection.neighbors ?? '—'}</div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="opacity-70">ID</div><div className="truncate" title={selection.id}>{selection.id}</div>
                  <div className="opacity-70">Source</div><div className="truncate" title={selection.source}>{selection.source}</div>
                  <div className="opacity-70">Target</div><div className="truncate" title={selection.target}>{selection.target}</div>
                  <div className="opacity-70">DEX</div><div>{selection.dex}</div>
                  <div className="opacity-70">Fee (bps)</div><div>{selection.fee_bps ?? '—'}</div>
                  <div className="opacity-70">Price A/B</div><div>{(selection as any).price_a_per_b ?? '—'}</div>
                  <div className="opacity-70">Pool Liquidity (raw)</div><div>{(selection as any).pool_liquidity_raw ?? '—'}</div>
                  <div className="opacity-70">Pool Kind</div><div>{(selection as any).pool_kind ?? '—'}</div>
                  <div className="opacity-70">Direction</div><div>{(selection as any).direction ?? '—'}</div>
                  <div className="opacity-70">TVL (USD)</div><div>{(selection as any).tvl_usd ?? '—'}</div>
                  <div className="opacity-70">Weight</div><div>{selection.weight ?? '—'}</div>
                  <div className="opacity-70">Pool ID</div><div className="truncate" title={(selection as any).pool_id || ''}>{(selection as any).pool_id || '—'}</div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div ref={containerRef} className="absolute inset-0">
        <CytoscapeComponent
          cy={onCyReady}
          elements={[]}
          style={{ width: '100%', height: '100%' }}
          stylesheet={styles as any}
          wheelSensitivity={0.2}
        />
      </div>
    </div>
  );
};


