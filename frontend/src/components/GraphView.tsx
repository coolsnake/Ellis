import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from '../utils/routes';
// @ts-ignore - types may be missing in some environments
import CytoscapeComponent from 'react-cytoscapejs';
import cytoscape, { ElementDefinition } from 'cytoscape';
import type { NodeSingular, EdgeSingular } from 'cytoscape';
// @ts-ignore - types may be missing in some environments
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

// Idle scheduler with fallback to a short timeout; keeps main thread responsive
type IdleHandle = number;
const idle = (cb: () => void, timeout = 100): IdleHandle => {
    try {
        const ric = (window as any).requestIdleCallback as any;
        if (typeof ric === 'function') return ric(cb, { timeout }) as unknown as IdleHandle;
    } catch {}
    return window.setTimeout(cb, Math.min(Math.max(timeout, 16), 250)) as unknown as IdleHandle;
};

// Small helper to batch Cytoscape mutations safely
const withBatch = (cy: any, fn: () => void) => {
    try { cy.startBatch(); } catch {}
    try { fn(); } finally { try { cy.endBatch(); } catch {} }
};

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

import { useSocket } from '../app/contexts/socket';

export const GraphView: React.FC<{ apiBase: string; socket?: any; square?: boolean }> = ({ apiBase, socket, square }) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const cyRef = useRef<cytoscape.Core | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Coalesce resize calls to prevent forced reflows from repeated synchronous cy.resize()
  const resizeScheduledRef = useRef(false);
  const scheduleResize = () => {
    const cy = cyRef.current; if (!cy) return;
    if (resizeScheduledRef.current) return;
    resizeScheduledRef.current = true;
    requestAnimationFrame(() => {
      try { cy.resize(); } catch {}
      resizeScheduledRef.current = false;
    });
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
	const [layoutName, setLayoutName] = useState<'fcose' | 'cose' | 'grid' | 'circle'>('fcose');
	const [filterDex, setFilterDex] = useState<{ Raydium: boolean; Orca: boolean; Meteora: boolean; MeteoraBalanced: boolean; Pumpswap: boolean }>({ Raydium: true, Orca: true, Meteora: true, MeteoraBalanced: true, Pumpswap: true });
	const [filterKind, setFilterKind] = useState<{ AMM: boolean; CLMM: boolean }>({ AMM: true, CLMM: true });
  const laidOutRef = useRef(false);
	const forceLayoutRef = useRef(false);
  const lastVersionRef = useRef<number>(0);
  const [selection, setSelection] = useState<
    | { kind: 'node'; id: string; label?: string; degree?: number; neighbors?: number }
    | { kind: 'edge'; id: string; source: string; target: string; dex: string; fee_bps?: number; liquidity?: number; weight?: number; price_a_per_b?: number; tvl_usd?: number; pool_id?: string; source_account?: string; target_account?: string; combined_edges?: Array<{ dex: string; pool_id?: string; fee_bps?: number; liquidity?: number; price_a_per_b?: number; tvl_usd?: number; pool_kind?: string; direction?: string; pool_liquidity_raw?: number }> }
    | { kind: 'path'; edges: Array<{ id: string; source: string; target: string; dex: string; fee_bps?: number; liquidity?: number; price_a_per_b?: number; tvl_usd?: number; pool_id?: string; pool_kind?: string; direction?: string; pool_liquidity_raw?: number }> }
    | null
  >(null);
  // Debug: allow disabling combined edges to show per-DEX edges directly
  const [combineEdges, setCombineEdges] = useState<boolean>(true);

	// Track active user interaction (pan/zoom) to gate expensive work
	const interactingRef = useRef(false);

	// Optional cap for rendered edges by priority to reduce overdraw
	const [maxEdges, setMaxEdges] = useState<number>(1200);
	const combineEdgesRef = useRef<boolean>(combineEdges);
	useEffect(() => { combineEdgesRef.current = combineEdges; }, [combineEdges]);
	const maxEdgesRef = useRef<number>(maxEdges);
	useEffect(() => { maxEdgesRef.current = maxEdges; }, [maxEdges]);
	const rawEdgeCountRef = useRef<number>(0);

	// Queue for recomputing combined edges across frames
	const pairQueueRef = useRef<string[]>([]);

	// Adaptive backpressure and dynamic degrade controls
	const avgFrameMsRef = useRef(16);
	const busyRef = useRef(false);
	const combinedEnabledRef = useRef(true);
	const skipNextFrameRef = useRef(false);

	const updatePerfBudget = (startTs: number) => {
		try {
			const dt = performance.now() - startTs;
			avgFrameMsRef.current = 0.85 * avgFrameMsRef.current + 0.15 * dt;
			if (avgFrameMsRef.current > 24) {
				// Skip every other frame when overloaded
				skipNextFrameRef.current = !skipNextFrameRef.current;
				// Disable combined edges first
				if (combinedEnabledRef.current) {
					combinedEnabledRef.current = false;
					try { setCombineEdges(false); } catch {}
				}
				// Lower edge cap progressively (min 400)
				setMaxEdges((prev) => (prev > 800 ? 800 : (prev > 600 ? 600 : (prev > 400 ? 400 : prev))));
			} else if (avgFrameMsRef.current < 18) {
				// Recover when we have headroom
				if (!combinedEnabledRef.current) {
					combinedEnabledRef.current = true;
					try { setCombineEdges(true); } catch {}
				}
				setMaxEdges((prev) => (prev < 800 ? 800 : prev));
				skipNextFrameRef.current = false;
			}
		} catch {}
	};

	// Track whether page/tab is visible and whether the graph container is on-screen
	const pageVisibleRef = useRef<boolean>(true);
	const isVisibleRef = useRef<boolean>(true);

	const styles: any[] = useMemo(() => ([
		{ selector: 'node', style: { 'background-color': '#3b82f6', 'label': '', 'font-size': 8, 'color': '#e5e7eb', 'text-outline-width': 1, 'text-outline-color': '#111827' } },
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
		{ selector: 'edge[dex = "Meteora"]', style: { 'line-color': '#06b6d4' } },
		// Hide original edges when a combined edge is rendered
		{ selector: 'edge[hiddenEdge = 1]', style: { 'display': 'none' } },
		// Slightly emphasize combined edges
		{ selector: 'edge[combined = 1]', style: { 'width': 2.5 } },
		{ selector: 'edge.highlighted', style: { 'line-color': '#ef4444', 'width': 3.5, 'opacity': 1 } },
		{ selector: ':selected', style: { 'line-color': '#ef4444', 'background-color': '#ef4444' } },
	]), []);

	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		if (combineEdges) return;
		withBatch(cy, () => {
			cy.edges('[combined = 1]').forEach((edge: any) => {
				try {
					const originals: string[] = Array.isArray(edge.data('combinedOriginalIds')) ? edge.data('combinedOriginalIds').map(String) : [];
					originals.forEach((id) => {
						const orig = cy.getElementById(id);
						if (orig && orig.length) { orig.data('hiddenEdge', null); }
					});
					edge.remove();
				} catch {}
			});
			recountRawEdgeCount(cy);
		});
	}, [combineEdges]);

// Track page/tab visibility
useEffect(() => {
  const onVis = () => { try { pageVisibleRef.current = (document.visibilityState === 'visible'); } catch {} };
  try { onVis(); } catch {}
  try { document.addEventListener('visibilitychange', onVis); } catch {}
  return () => { try { document.removeEventListener('visibilitychange', onVis); } catch {} };
}, []);

// Track container viewport visibility
useEffect(() => {
  const el = containerRef.current as any;
  try {
    const IO: any = (window as any).IntersectionObserver;
    if (!el || !IO) return;
    const io = new IO((entries: any[]) => {
      try {
        const e = entries?.[0];
        isVisibleRef.current = !!(e && e.isIntersecting);
      } catch {}
    }, { threshold: 0.01 });
    io.observe(el);
    return () => { try { io.disconnect(); } catch {} };
  } catch {}
}, [containerRef.current]);

	const toElements = (snap: GraphSnapshot): ElementDefinition[] => {
		const hideDex = new Set<string>();
		if (!filterDex.Raydium) hideDex.add('Raydium');
		if (!filterDex.Orca) hideDex.add('Orca');
		if (!filterDex.Meteora) hideDex.add('Meteora');
		if (!filterDex.MeteoraBalanced) hideDex.add('MeteoraBalanced');
		if (!filterDex.Pumpswap) hideDex.add('Pumpswap');
		const hideKind = new Set<string>();
		if (!filterKind.AMM) hideKind.add('amm');
		if (!filterKind.CLMM) hideKind.add('clmm');
		const nodes: ElementDefinition[] = snap.nodes.map((n) => ({ data: { id: n.id, label: '' } }));
		// Build raw edge definitions (without DEX visibility filter yet for grouping)
		let rawEdges: ElementDefinition[] = snap.edges
			.filter((e) => {
				const kind = (e as any).pool_kind;
				return kind === 'amm' || kind === 'clmm' ? !hideKind.has(kind) : true;
			})
			.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, dex: e.dex, fee_bps: e.fee_bps, liquidity: e.liquidity, liquidity_display: (e as any).liquidity_display, weight: e.weight, price_a_per_b: (e as any).price_a_per_b, tvl_usd: (e as any).tvl_usd, pool_id: (e as any).pool_id, source_account: (e as any).source_account, target_account: (e as any).target_account, pool_kind: (e as any).pool_kind, direction: (e as any).direction, pool_liquidity_raw: (e as any).pool_liquidity_raw, cpd: 0 } }));

		// Limit the number of edges to a configurable max
		if (maxEdges > 0 && rawEdges.length > maxEdges) {
			rawEdges = rawEdges.slice(0, maxEdges);
		}

    // Group by directed pair and create combined edges when both DEXes exist and both are enabled
		const byPair = new Map<string, ElementDefinition[]>();
		for (const ed of rawEdges) {
			const a = String((ed.data as any).source);
			const b = String((ed.data as any).target);
			const key = `${a}->${b}`;
			const arr = byPair.get(key) || [];
			arr.push(ed);
			byPair.set(key, arr);
		}

		const edges: ElementDefinition[] = [];
    for (const [, arr] of byPair) {
			// Consider only edges whose DEX is not hidden by filter
			const visible = arr.filter((e) => !hideDex.has(String((e.data as any).dex)));
			// Count distinct DEX among visible edges
			const dexSet = new Set<string>();
			for (const ed of visible) { dexSet.add(String((ed.data as any).dex)); }
      if (combineEdges && dexSet.size >= 2) {
				const anyEd = visible[0];
				const source = String((anyEd.data as any).source);
				const target = String((anyEd.data as any).target);
				const combinedOriginalIds = visible.map((ed) => String((ed.data as any).id));
				const combinedEdgesDetails = visible.map((ed) => ({
					dex: String((ed.data as any).dex),
					pool_id: (ed.data as any).pool_id,
					fee_bps: (ed.data as any).fee_bps,
					liquidity: (ed.data as any).liquidity,
					price_a_per_b: (ed.data as any).price_a_per_b,
					tvl_usd: (ed.data as any).tvl_usd,
					pool_kind: (ed.data as any).pool_kind,
					direction: (ed.data as any).direction,
					pool_liquidity_raw: (ed.data as any).pool_liquidity_raw,
				}));
				edges.push({ data: { id: `combined:${source}->${target}`, source, target, dex: 'Combined', combined: 1, combinedOriginalIds, combinedEdgesDetails, cpd: 0 } } as ElementDefinition);
				// Keep originals but mark hidden, so they can still be referenced by id for highlighting
				for (const ed of visible) {
					(ed.data as any).hiddenEdge = 1;
					edges.push(ed);
				}
      } else {
				// Render only those edges whose DEX is enabled
				for (const ed of visible) {
					edges.push(ed);
				}
			}
		}

		// Assign per-pair control-point distances; ignore hidden originals
		const group = new Map<string, ElementDefinition[]>();
		for (const ed of edges) {
			if ((ed.data as any).hiddenEdge === 1) continue;
			const a = String((ed.data as any).source);
			const b = String((ed.data as any).target);
			const key = a < b ? `${a}|${b}` : `${b}|${a}`;
			const arr2 = group.get(key) || [];
			arr2.push(ed);
			group.set(key, arr2);
		}
		for (const [, arr2] of group) {
			arr2.sort((x, y) => String((x.data as any).id).localeCompare(String((y.data as any).id)));
			const count = arr2.length;
			if (count <= 1) continue;
			const step = 24;
			for (let i = 0; i < count; i++) {
				const k = i - (count - 1) / 2;
				(arr2[i].data as any).cpd = Math.round(k * step);
			}
		}
		return [...nodes, ...edges];
  };

  // Minimal toggle control UI (hook into existing controls region if present)
  // If there is a toolbar/controls, wire this state into it; otherwise, leave as internal

	// Helper: find edges between nodes with optional flags to avoid fragile selector strings
	const findEdgesBetween = (
		cy: cytoscape.Core,
		a: string,
		b: string,
		opts?: { includeBoth?: boolean; excludeHidden?: boolean; excludeCombined?: boolean; dex?: string }
	) => {
		const includeBoth = opts?.includeBoth ?? false;
		const excludeHidden = opts?.excludeHidden ?? false;
		const excludeCombined = opts?.excludeCombined ?? false;
		const dex = opts?.dex ?? '';
		return cy.edges().filter((e) => {
			try {
				const src = String(e.data('source'));
				const dst = String(e.data('target'));
				const matchesPair = includeBoth ? ((src === a && dst === b) || (src === b && dst === a)) : (src === a && dst === b);
				if (!matchesPair) return false;
				if (excludeHidden && e.data('hiddenEdge') === 1) return false;
				if (excludeCombined && e.data('combined') === 1) return false;
				if (dex && String(e.data('dex')) !== dex) return false;
				return true;
			} catch { return false; }
		});
	};

	// Recompute control-point distances to fan out parallel edges between two nodes
	const recomputeParallelOffsets = (cy: cytoscape.Core, a: string, b: string, step: number = 24) => {
		try {
				const sel = findEdgesBetween(cy, a, b, { includeBoth: true, excludeHidden: true });
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

	// Seed initial positions for nodes that didn't exist before this refresh,
	// placing them near the average of positioned neighbors (or center with jitter)
	const seedPositionsForNewNodes = (
		cy: cytoscape.Core,
		prevPos: Map<string, { x: number; y: number }>,
		candidateIds?: Iterable<string>
	) => {
		try {
			const nodes: cytoscape.NodeSingular[] = [];
			if (candidateIds) {
				for (const rawId of candidateIds) {
					const id = String(rawId);
					const node = cy.getElementById(id);
					if (node && node.length && node.isNode()) {
						nodes.push(node as cytoscape.NodeSingular);
					}
				}
			} else {
				const all = cy.nodes(); if (!all || all.length === 0) return;
				nodes.push(...all.toArray());
			}
			if (!nodes.length) return;
			let cx = 0, cyy = 0;
			try { const bb = cy.extent(); cx = (bb.x1 + bb.x2) / 2; cyy = (bb.y1 + bb.y2) / 2; } catch {}
			const isNew = (id: string) => !prevPos.has(id);
			nodes.forEach((n) => {
				const id = n.id();
				if (!isNew(id)) return;
				let sumX = 0, sumY = 0, cnt = 0;
				try {
					n.connectedEdges().forEach((e) => {
						try {
							const s = String(e.data('source'));
							const t = String(e.data('target'));
							const otherId = s === id ? t : t === id ? s : '';
							if (!otherId) return;
							const nb = cy.getElementById(otherId);
							if (nb && nb.isNode() && nb.length) {
								const px = Number(nb.position('x'));
								const py = Number(nb.position('y'));
								if (Number.isFinite(px) && Number.isFinite(py)) { sumX += px; sumY += py; cnt++; }
							}
						} catch {}
					});
				} catch {}
				let nx = cx, ny = cyy;
				if (cnt > 0) { nx = sumX / cnt; ny = sumY / cnt; }
				const jitter = 12;
				const rx = (Math.random() - 0.5) * jitter;
				const ry = (Math.random() - 0.5) * jitter;
				try { n.position({ x: nx + rx, y: ny + ry }); } catch {}
			});
		} catch {}
	};

	const recountRawEdgeCount = (cy: cytoscape.Core) => {
		try {
			rawEdgeCountRef.current = cy.edges().reduce((acc: number, edge: any) => {
				return edge?.data('combined') === 1 ? acc : acc + 1;
			}, 0);
		} catch {}
	};

	// Ensure combined edge exists (or is removed) for a directed pair, and originals are hidden/shown appropriately
	const ensureCombinedForPair = (cy: cytoscape.Core, a: string, b: string) => {
		try {
			const originals = findEdgesBetween(cy, a, b, { excludeCombined: true });
			const combinedId = `combined:${a}->${b}`;
			const wantCombined = combineEdgesRef.current;
			const existing = cy.getElementById(combinedId);
			if (!originals || originals.length === 0) {
				if (existing && existing.length) { try { existing.remove(); } catch {} }
				return;
			}
			if (!wantCombined) {
				if (existing && existing.length) { try { existing.remove(); } catch {} }
				originals.forEach((e) => { try { e.data('hiddenEdge', null); } catch {} });
				recomputeParallelOffsets(cy, a, b);
				return;
			}
			// Filter by currently visible DEX
			let vis = originals;
			try {
				vis = vis.filter((e) => {
					const dx = String(e.data('dex'));
					if (!filterDex.Raydium && dx === 'Raydium') return false;
					if (!filterDex.Orca && dx === 'Orca') return false;
					if (!filterDex.Meteora && dx === 'Meteora') return false;
					if (!filterDex.MeteoraBalanced && dx === 'MeteoraBalanced') return false;
					if (!filterDex.Pumpswap && dx === 'Pumpswap') return false;
					return true;
				});
			} catch {}
			const dexSet = new Set<string>();
			vis.forEach((e) => { try { dexSet.add(String(e.data('dex'))); } catch {} });
			if (dexSet.size >= 2) {
				const all = vis;
				const originalIds: string[] = [];
				const details: any[] = [];
				all.forEach((e) => {
					try {
						originalIds.push(String(e.id()));
						details.push({
							dex: String(e.data('dex')),
							pool_id: e.data('pool_id'),
							fee_bps: e.data('fee_bps'),
							liquidity: e.data('liquidity'),
							price_a_per_b: e.data('price_a_per_b'),
							tvl_usd: e.data('tvl_usd'),
							pool_kind: e.data('pool_kind'),
							direction: e.data('direction'),
							pool_liquidity_raw: e.data('pool_liquidity_raw'),
						});
					} catch {}
				});
				if (!existing || existing.length === 0) {
					cy.add({ data: { id: combinedId, source: a, target: b, dex: 'Combined', combined: 1, combinedOriginalIds: originalIds, combinedEdgesDetails: details, cpd: 0 } } as any);
				} else {
					try { existing.data('combinedOriginalIds', originalIds); existing.data('combinedEdgesDetails', details); } catch {}
				}
				originals.forEach((e) => { try { e.data('hiddenEdge', 1); } catch {} });
			} else {
				if (existing && existing.length) { try { existing.remove(); } catch {} }
				originals.forEach((e) => { try { e.data('hiddenEdge', null); } catch {} });
			}
			recomputeParallelOffsets(cy, a, b);
		} catch {}
	};

	type FitMode = 'never' | 'first' | 'always';
	const runLayout = (fitMode: FitMode = 'first') => {
    const cy = cyRef.current; if (!cy) return;
    const name = layoutName;
		const shouldFit = fitMode === 'always' || (fitMode === 'first' && !laidOutRef.current);
		// If there are no nodes yet, defer layout until we have content
		if (cy.nodes().length === 0) return;
		const nodeCount = cy.nodes().length;
		// Avoid heavy force-directed layouts for very large graphs; fall back to grid
		const chosen = (nodeCount > 1200 && (name === 'fcose' || name === 'cose')) ? 'grid' : name;
		const options: any = chosen === 'fcose'
			? { name: 'fcose', animate: false, fit: false, quality: 'draft', randomize: !laidOutRef.current, nodeSeparation: 75, nodeRepulsion: 4500 }
			: { name: chosen, animate: false, fit: false };
		const layout = cy.layout(options);
		if (shouldFit) {
			try { cy.one('layoutstop', () => { try { cy.fit(undefined, 20); } catch {} }); } catch {}
		}
		layout.run();
		// Schedule resize on next frame to avoid sync layout thrash
		scheduleResize();
    laidOutRef.current = true;
  };

  const refitAndResize = () => {
    // Re-run the current layout and fit so the current algorithm is applied
    runLayout('always');
  };

		// Apply edge highlighting given edge ids and/or (source,target,dex) pairs
    const applyHighlight = async (payload: { edgeIds?: string[]; pairs?: Array<{ source: string; target: string; dex?: string }>; fit?: boolean; pathDetails?: boolean } = {}, opts?: { noFit?: boolean; noDetails?: boolean }) => {
    try {
      const cy = cyRef.current; if (!cy) return;
      const ids = (payload?.edgeIds || []).filter(Boolean);
      const pairs = Array.isArray(payload?.pairs) ? payload?.pairs : [];
      if (!ids.length && !pairs.length) return;
      // Prefetch details for path rendering if requested
      if (payload.pathDetails && !opts?.noDetails) {
        try {
          const pairList = pairs?.map((p) => ({ source: String(p.source), target: String(p.target), dex: p.dex ? String(p.dex) : undefined })) as any;
          const fetched = await (async () => {
            // @ts-ignore - fetchEdgeDetails bound in onCyReady scope
            if (typeof (fetchEdgeDetails as any) === 'function') {
              // @ts-ignore
              return await (fetchEdgeDetails as any)(ids, pairList);
            }
            return [] as any[];
          })();
          // @ts-ignore - hydrateEdgesInCy bound in onCyReady scope
          if (Array.isArray(fetched) && typeof (hydrateEdgesInCy as any) === 'function') {
            // @ts-ignore
            (hydrateEdgesInCy as any)(cy, fetched);
          }
        } catch {}
      }
      // Clear previous highlight
      cy.edges().removeClass('highlighted');
      // Match by ids (including reverse suffix) and by (source,target,dex) pairs
      const allIds: string[] = [];
      for (const id of ids) { allIds.push(id, `${id}-rev`); }
				const idSelector = allIds.length ? allIds.map((id) => `#${id}`).join(',') : '';
				let collection = idSelector ? cy.$(idSelector) : cy.collection();
				for (const p of pairs) {
					const src = String(p.source);
					const dst = String(p.target);
					const dex = p.dex ? String(p.dex) : '';
					const edges = findEdgesBetween(cy, src, dst, { dex });
					collection = collection.union(edges);
				}
				collection.addClass('highlighted');
      // Highlight combined edges when originals are highlighted or when pair matches
      try {
        if (allIds.length) {
          const combined = cy.edges('[combined = 1]');
          combined.forEach((e) => {
            const list: string[] = Array.isArray(e.data('combinedOriginalIds')) ? e.data('combinedOriginalIds') : [];
            if (list.some((x) => allIds.includes(String(x)))) e.addClass('highlighted');
          });
        }
					for (const p of pairs) {
						const src = String(p.source);
						const dst = String(p.target);
						findEdgesBetween(cy, src, dst, {}).filter((e) => e.data('combined') === 1).addClass('highlighted');
					}
      } catch {}
      // Optionally focus view on highlighted selection
			try { if (collection && collection.length) { cy.fit(collection, 40); } } catch {}

      // Build ordered path details and open the Path details panel
      if (payload.pathDetails) {
        try {
          const pathEdges: Array<{ id: string; source: string; target: string; dex: string; fee_bps?: number; liquidity?: number; price_a_per_b?: number; tvl_usd?: number; pool_id?: string; pool_kind?: string; direction?: string; pool_liquidity_raw?: number }> = [];
          const seen = new Set<string>();
          const pushEdge = (e: EdgeSingular | null) => {
            if (!e || !e.length) return;
            if (e.data('combined') === 1) return; // skip combined in details; show underlying hops
            const id = String(e.id());
            if (seen.has(id)) return;
            seen.add(id);
            pathEdges.push({
              id,
              source: String(e.data('source')),
              target: String(e.data('target')),
              dex: String(e.data('dex')),
              fee_bps: e.data('fee_bps'),
              liquidity: e.data('liquidity'),
              price_a_per_b: e.data('price_a_per_b'),
              tvl_usd: e.data('tvl_usd'),
              pool_id: e.data('pool_id'),
              pool_kind: e.data('pool_kind'),
              direction: e.data('direction'),
              pool_liquidity_raw: e.data('pool_liquidity_raw'),
            });
          };
          if (ids.length) {
            for (const rawId of ids) {
              const e = cy.getElementById(String(rawId));
              if (e && e.length && e.isEdge()) { pushEdge(e as any); continue; }
              const rev = cy.getElementById(`${String(rawId)}-rev`);
              if (rev && rev.length && rev.isEdge()) { pushEdge(rev as any); }
            }
					} else if (pairs.length) {
            for (const p of pairs) {
              const src = String(p.source);
              const dst = String(p.target);
              const dex = p.dex ? String(p.dex) : '';
							let cand = findEdgesBetween(cy, src, dst, { dex, excludeCombined: true });
							if (!cand || cand.length === 0) cand = findEdgesBetween(cy, src, dst, { dex });
							pushEdge((cand && cand.length) ? (cand[0] as any) : null);
            }
          }
          if (pathEdges.length) setSelection({ kind: 'path', edges: pathEdges });
        } catch {}
      }
    } catch {}
  };

  const loadSnapshot = async () => {
    setLoading(true); setError(null);
    try {
      // Skip heavy snapshot load when not visible; will be loaded on first visibility
      if (!pageVisibleRef.current || !isVisibleRef.current) { return; }
      // Also defer when user is interacting (pan/zoom) to avoid jank
      if (interactingRef.current) {
        idle(() => { if (!interactingRef.current) { try { loadSnapshot(); } catch {} } }, 150);
        return;
      }
      const r = await fetch(`${apiBase}${ROUTES.graph.snapshot}?lite=1`);
      const j: GraphSnapshot = await r.json();
      const cy = cyRef.current; if (!cy) return;
      // Capture previous node positions to preserve layout across refreshes
      const hadLayout = !!laidOutRef.current;
      const preservePositions = hadLayout && !forceLayoutRef.current;
      const prevPos = new Map<string, { x: number; y: number }>();
      try { cy.nodes().forEach((n) => { prevPos.set(n.id(), { x: n.position('x'), y: n.position('y') }); }); } catch {}
      cy.elements().remove();
			cy.add(toElements(j));
			recountRawEdgeCount(cy);
      // Restore positions for existing nodes when preserving layout
      if (preservePositions) {
        try { cy.nodes().forEach((n) => { const p = prevPos.get(n.id()); if (p) n.position(p); }); } catch {}
      }
			// Seed positions for new nodes to avoid stacking at origin
			seedPositionsForNewNodes(cy, prevPos);
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
					scheduleResize();
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
      // keep selection and viewport stable on refresh
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
	}, [filterDex.Raydium, filterDex.Orca, filterDex.Meteora, filterDex.MeteoraBalanced, filterDex.Pumpswap, filterKind.AMM, filterKind.CLMM]);

  // Ensure we don't leave the server thinking we're busy after unmount
  useEffect(() => {
    return () => {
      try { effectiveSocket?.emit('graph:idle'); } catch {}
    };
  }, [effectiveSocket]);

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

  // Notify server when the graph becomes visible/hidden so it can gate streaming
  useEffect(() => {
    if (!effectiveSocket) return;
    let last = -1 as number;
    const send = () => {
      const v = !!(pageVisibleRef.current && isVisibleRef.current);
      const n = v ? 1 : 0;
      if (n !== last) { last = n; try { effectiveSocket.emit('graph:visible', v); } catch {} }
    };
    try {
      const onVis = () => send();
      document.addEventListener('visibilitychange', onVis);
      // Re-evaluate when intersection updates happen (isVisibleRef is updated in IO callback above)
      const checkInterval = window.setInterval(send, 1000);
      send();
      return () => {
        try { document.removeEventListener('visibilitychange', onVis); } catch {}
        try { window.clearInterval(checkInterval); } catch {}
        try { effectiveSocket.emit('graph:visible', false); } catch {}
      };
    } catch {
      try { effectiveSocket.emit('graph:visible', !!(pageVisibleRef.current && isVisibleRef.current)); } catch {}
      return () => { try { effectiveSocket.emit('graph:visible', false); } catch {} };
    }
  }, [effectiveSocket]);

	const snapshotInitializedRef = useRef(false);

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
        scheduleResize();
      }
    }) : null;
    if (ro) ro.observe(el);
    let winResizeRaf: number | null = null;
    const onWinResize = () => {
      if (winResizeRaf) cancelAnimationFrame(winResizeRaf);
      winResizeRaf = requestAnimationFrame(() => {
        scheduleResize();
        winResizeRaf = null;
      });
    };
    window.addEventListener('resize', onWinResize);
    return () => {
      window.removeEventListener('resize', onWinResize);
      try { ro && ro.disconnect(); } catch {}
    };
  }, [containerRef.current]);

  // DISABLED: Real-time socket updates removed - graph now only updates via manual "Refresh Graph" button
  // This allows the graph to be a stable snapshot for validation and analysis rather than continuously updating
  useEffect(() => {
		if (!effectiveSocket) return;

		// Keep only the highlight listener for path visualization (triggered from arbitrage panel)
		const onHighlight = (payload: { edgeIds?: string[]; pairs?: Array<{ source: string; target: string; dex?: string }> }) => {
			// Defer to idle to avoid blocking main thread
			idle(() => {
				applyHighlight(payload as any);
			}, 100); // 100ms timeout to allow interaction to settle
		};

		effectiveSocket.on('graph-highlight', onHighlight);
		return () => {
			effectiveSocket.off('graph-highlight', onHighlight);
		};
	}, [effectiveSocket]);

  // Initialize cy configuration when instance is available
	const onCyReady = (cy: cytoscape.Core) => {
    cyRef.current = cy;
    // Clamp zoom range to avoid pathological scales where elements appear too small
    try { cy.minZoom(0.02); cy.maxZoom(8); } catch {}
		// Ensure user can pan/zoom freely
		try { cy.userZoomingEnabled(true); cy.panningEnabled(true); } catch {}
    // Ensure correct viewport, but schedule to avoid sync reflow
    scheduleResize();
		// Do not auto-fit here; initial layout will handle a single fit once when size is ready

		// Prefer cheaper rendering on HiDPI and toggle perf options during interaction
		try { (cy as any).renderer?.().setPixelRatio?.(1); } catch {}
		try {
			const r: any = (cy as any).renderer?.();
			if (r && r.options) {
				Object.assign(r.options, {
					motionBlur: false,
					textureOnViewport: true,
					hideLabelsOnViewport: false,
					hideEdgesOnViewport: false,
					motionBlurOpacity: 0.2,
				});
			}
		} catch {}
		let perfRaf: number | null = null;
		const enablePerf = () => {
			try {
				const r: any = (cy as any).renderer?.();
				if (r && r.options) Object.assign(r.options, { motionBlur: true, textureOnViewport: true, hideLabelsOnViewport: true, hideEdgesOnViewport: true, motionBlurOpacity: 0.2 });
			} catch {}
		};
		const disablePerf = () => {
			try {
				const r: any = (cy as any).renderer?.();
				if (r && r.options) Object.assign(r.options, { motionBlur: false, hideLabelsOnViewport: false, hideEdgesOnViewport: false });
			} catch {}
		};
		const onInteract = () => {
			interactingRef.current = true;
			enablePerf();
			if (perfRaf) cancelAnimationFrame(perfRaf as any);
			perfRaf = requestAnimationFrame(() => setTimeout(() => { interactingRef.current = false; disablePerf(); }, 150));
		};
		try { cy.on('pan zoom', onInteract as any); } catch {}

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
    // Details cache + fetchers for on-demand hydration
    const detailsCache = new Map<string, any>();
    const MAX_DETAILS = 5000;
    const pruneDetailsCache = () => {
      try {
        if (detailsCache.size > MAX_DETAILS) {
          const over = detailsCache.size - MAX_DETAILS;
          for (let i = 0; i < over; i++) {
            const it = detailsCache.keys().next();
            if (it && !it.done) detailsCache.delete(it.value); else break;
          }
        }
      } catch {}
    };
    const fetchEdgeDetails = async (ids: string[], pairs?: Array<{ source: string; target: string; dex?: string }>) => {
      const want = (ids || []).map(String).filter(Boolean);
      const missing = want.filter((id) => !detailsCache.has(id));
      if (missing.length === 0 && (!pairs || pairs.length === 0)) return [] as any[];
      const r = await fetch(`${apiBase}${ROUTES.graph.edgeDetails}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: missing, pairs }),
      });
      const j = await r.json();
      const edges: any[] = Array.isArray(j?.edges) ? j.edges : [];
      edges.forEach((e: any) => detailsCache.set(String(e.id), e));
      pruneDetailsCache();
      return edges;
    };
    const hydrateEdgesInCy = (core: cytoscape.Core, edges: any[]) => {
      edges.forEach((e) => {
        const id = String(e?.id || ''); if (!id) return;
        const el = core.getElementById(id);
        if (el && el.length && el.isEdge()) {
          el.data({
            ...el.data(),
            fee_bps: e.fee_bps,
            liquidity: e.liquidity,
            liquidity_display: e.liquidity_display,
            weight: e.weight,
            price_a_per_b: e.price_a_per_b,
            tvl_usd: e.tvl_usd,
            pool_id: e.pool_id,
            source_account: e.source_account,
            target_account: e.target_account,
            pool_kind: e.pool_kind,
            direction: e.direction,
            pool_liquidity_raw: e.pool_liquidity_raw,
          });
        }
      });
    };

    cy.on('tap', 'edge', async (evt) => {
      const e = evt.target as EdgeSingular;
      const isCombined = e.data('combined') === 1;
      if (isCombined) {
        const ids: string[] = (Array.isArray(e.data('combinedOriginalIds')) ? e.data('combinedOriginalIds') : []).map(String);
        const fetched = await fetchEdgeDetails(ids);
        hydrateEdgesInCy(cy, fetched.length ? fetched : ids.map((id) => detailsCache.get(id)).filter(Boolean));
      } else {
        const id = String(e.id());
        const fetched = await fetchEdgeDetails([id]);
        hydrateEdgesInCy(cy, fetched.length ? fetched : [detailsCache.get(id)].filter(Boolean));
      }
      const combinedEdgesDetails = isCombined
        ? (e.data('combinedOriginalIds') || []).map((id: string) => detailsCache.get(String(id))).filter(Boolean)
        : undefined;
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
        ...(Array.isArray(combinedEdgesDetails) ? { combined_edges: combinedEdgesDetails } : {}),
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
					<input type="checkbox" checked={filterDex.Meteora} onChange={(e) => setFilterDex((p) => ({ ...p, Meteora: e.target.checked }))} /> Meteora DLMM
				</label>
				<label className="text-sm flex items-center gap-1">
					<input type="checkbox" checked={filterDex.MeteoraBalanced} onChange={(e) => setFilterDex((p) => ({ ...p, MeteoraBalanced: e.target.checked }))} /> Meteora Balanced
				</label>
				<label className="text-sm flex items-center gap-1">
					<input type="checkbox" checked={filterDex.Pumpswap} onChange={(e) => setFilterDex((p) => ({ ...p, Pumpswap: e.target.checked }))} /> Pumpswap
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
								<div className="font-semibold">{selection.kind === 'node' ? 'Node' : (selection.kind === 'edge' ? 'Edge' : 'Path')} details</div>
                <button className="px-1 py-0.5 text-xs border rounded" onClick={() => setSelection(null)}>Close</button>
              </div>
							{selection.kind === 'node' ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="opacity-70">ID</div><div className="truncate" title={selection.id}>{selection.id}</div>
                  <div className="opacity-70">Label</div><div className="truncate" title={selection.label || ''}>{selection.label || '—'}</div>
                  <div className="opacity-70">Degree</div><div>{selection.degree ?? '—'}</div>
                  <div className="opacity-70">Neighbors</div><div>{selection.neighbors ?? '—'}</div>
                </div>
							) : selection.kind === 'edge' ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="opacity-70">ID</div><div className="truncate" title={selection.id}>{selection.id}</div>
                  <div className="opacity-70">Source</div><div className="truncate" title={selection.source}>{selection.source}</div>
                  <div className="opacity-70">Target</div><div className="truncate" title={selection.target}>{selection.target}</div>
                  {/* If this is a combined edge, render a compact comparison for each DEX */}
                  {Array.isArray((selection as any).combined_edges) ? (
                    <>
                      <div className="col-span-2 mt-1 font-semibold">DEX comparison</div>
                      {((selection as any).combined_edges as any[]).map((ed: any, i: number) => (
                        <React.Fragment key={i}>
                          <div className="opacity-70">DEX</div><div>{ed.dex}</div>
                          <div className="opacity-70">Fee (bps)</div><div>{ed.fee_bps ?? '—'}</div>
                          <div className="opacity-70">Price A/B</div><div>{(() => { const v = ed.price_a_per_b as any; return (typeof v === 'number' && v > 0) ? `${v} (B/A: ${1 / v})` : '—'; })()}</div>
                          <div className="opacity-70">Pool Liquidity (raw)</div><div>{ed.pool_liquidity_raw ?? '—'}</div>
                          <div className="opacity-70">Pool Kind</div><div>{ed.pool_kind ?? '—'}</div>
                          <div className="opacity-70">Direction</div><div>{ed.direction ?? '—'}</div>
                          <div className="opacity-70">TVL (USD)</div><div>{ed.tvl_usd ?? '—'}</div>
                          <div className="opacity-70">Pool ID</div><div className="truncate" title={ed.pool_id || ''}>{ed.pool_id || '—'}</div>
                          {i < ((selection as any).combined_edges as any[]).length - 1 ? <div className="col-span-2 border-t border-white/10 my-1" /> : null}
                        </React.Fragment>
                      ))}
                    </>
                  ) : (
                    <>
                      <div className="opacity-70">DEX</div><div>{selection.dex}</div>
                      <div className="opacity-70">Fee (bps)</div><div>{selection.fee_bps ?? '—'}</div>
                      <div className="opacity-70">Price A/B</div><div>{(() => { const v = (selection as any).price_a_per_b; return (typeof v === 'number' && v > 0) ? `${v} (B/A: ${1 / v})` : '—'; })()}</div>
                      <div className="opacity-70">Pool Liquidity (raw)</div><div>{(selection as any).pool_liquidity_raw ?? '—'}</div>
                      <div className="opacity-70">Pool Kind</div><div>{(selection as any).pool_kind ?? '—'}</div>
                      <div className="opacity-70">Direction</div><div>{(selection as any).direction ?? '—'}</div>
                      <div className="opacity-70">TVL (USD)</div><div>{(selection as any).tvl_usd ?? '—'}</div>
                      <div className="opacity-70">Weight</div><div>{selection.weight ?? '—'}</div>
                      <div className="opacity-70">Pool ID</div><div className="truncate" title={(selection as any).pool_id || ''}>{(selection as any).pool_id || '—'}</div>
                    </>
                  )}
                </div>
							) : (
								// Path details panel: list each hop's edge details in order
								<div className="grid grid-cols-2 gap-x-3 gap-y-1">
									<div className="opacity-70">Hops</div><div>{(selection.edges || []).length}</div>
									{(selection.edges || []).map((ed, i) => (
										<React.Fragment key={ed.id || i}>
											<div className="col-span-2 border-t border-white/10 my-1" />
											<div className="opacity-70">Hop</div><div>{i + 1}</div>
											<div className="opacity-70">Edge ID</div><div className="truncate" title={ed.id}>{ed.id}</div>
											<div className="opacity-70">Source</div><div className="truncate" title={ed.source}>{ed.source}</div>
											<div className="opacity-70">Target</div><div className="truncate" title={ed.target}>{ed.target}</div>
											<div className="opacity-70">DEX</div><div>{ed.dex}</div>
											<div className="opacity-70">Fee (bps)</div><div>{ed.fee_bps ?? '—'}</div>
                                            <div className="opacity-70">Price A/B</div><div>{(() => { const v = ed.price_a_per_b as any; return (typeof v === 'number' && v > 0) ? `${v} (B/A: ${1 / v})` : '—'; })()}</div>
											<div className="opacity-70">Pool Liquidity (raw)</div><div>{ed.pool_liquidity_raw ?? '—'}</div>
											<div className="opacity-70">Pool Kind</div><div>{ed.pool_kind ?? '—'}</div>
											<div className="opacity-70">Direction</div><div>{ed.direction ?? '—'}</div>
											<div className="opacity-70">TVL (USD)</div><div>{ed.tvl_usd ?? '—'}</div>
											<div className="opacity-70">Pool ID</div><div className="truncate" title={ed.pool_id || ''}>{ed.pool_id || '—'}</div>
										</React.Fragment>
									))}
								</div>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div ref={containerRef} className="absolute inset-0" style={{ contain: 'layout paint', contentVisibility: 'auto' } as any}>
        <CytoscapeComponent
          cy={onCyReady}
          elements={[]}
          // Memoize style to avoid new object every render (prop churn -> reflow)
          style={useMemo(() => ({ width: '100%', height: '100%' }), [])}
          stylesheet={styles as any}
        />
      </div>
    </div>
  );
};


