import type { GraphSnapshot } from './graph.types.js';

export function findPathInSnapshot(snap: GraphSnapshot, fromMint: string, toMint: string): { path: string[] } {
  const adj = new Map<string, Set<string>>();
  for (const n of snap.nodes) adj.set(n.id, new Set());
  for (const e of snap.edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  const start = fromMint; const goal = toMint;
  if (!adj.has(start) || !adj.has(goal)) return { path: [] };
  const queue: string[] = [start];
  const prev = new Map<string, string | null>();
  prev.set(start, null);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    for (const nxt of (adj.get(cur) || [])) {
      if (!prev.has(nxt)) { prev.set(nxt, cur); queue.push(nxt); }
    }
  }
  if (!prev.has(goal)) return { path: [] };
  const out: string[] = [];
  let cur: string | null = goal;
  while (cur) { out.push(cur); cur = prev.get(cur) || null; }
  out.reverse();
  return { path: out };
}


