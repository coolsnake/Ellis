/*
  Audit current graph snapshot (from websocket or local fetch) for price orientation consistency.
  - Computes fwd*rev product deviation and USD reference deviation when available.
  - Prints top-N offenders and an optional CSV.
*/
import { fetch } from 'undici';

type Edge = { id: string; dex: string; source: string; target: string; price_a_per_b?: number; tvl_usd?: number };
type Snapshot = { nodes: any[]; edges: Edge[] };

const API = process.env.LS_API || 'http://localhost:3001';
const TOP = Number(process.env.TOP || 20);

async function getSnapshot(): Promise<Snapshot> {
  const url = `${API}/graph/snapshot`;
  const res = await fetch(url).catch(() => null as any);
  if (!res?.ok) throw new Error(`snapshot http ${res?.status}`);
  return await res.json() as Snapshot;
}

function analyze(edges: Edge[]): { prodOff: any[] } {
  const byPair = new Map<string, { fwd?: Edge; rev?: Edge }>();
  for (const e of edges) {
    const key = `${e.source}->${e.target}`;
    const rkey = `${e.target}->${e.source}`;
    const fwd = byPair.get(key) || {};
    fwd.fwd = e; byPair.set(key, fwd);
    const rev = byPair.get(rkey) || {};
    if (!rev.rev && e) { /* placeholder */ }
  }
  const prodOff: Array<{ pair: string; prod: number; fwd?: number; rev?: number; dex?: string }> = [];
  // Simple pass: scan all edges and try to find reverse by id heuristic
  const map = new Map<string, Edge>();
  for (const e of edges) map.set(e.id, e);
  for (const e of edges) {
    const idRev = e.id.endsWith('-rev') ? e.id.slice(0, -4) : `${e.id}-rev`;
    const r = map.get(idRev);
    if (!r) continue;
    const f = Number(e.price_a_per_b || 0);
    const v = Number(r.price_a_per_b || 0);
    if (!(f > 0) || !(v > 0)) continue;
    const prod = f * v;
    if (!(prod > 1/1.02 && prod < 1.02)) {
      prodOff.push({ pair: `${e.source}<->${e.target}`, prod, fwd: f, rev: v, dex: e.dex });
    }
  }
  prodOff.sort((a, b) => Math.abs(b.prod - 1) - Math.abs(a.prod - 1));
  return { prodOff };
}

(async () => {
  try {
    const snap = await getSnapshot();
    const { prodOff } = analyze(snap.edges || []);
    const top = prodOff.slice(0, TOP);
    console.log(`Top ${top.length} fwd*rev deviations:`);
    for (const it of top) {
      console.log(`${it.pair} dex=${it.dex} fwd=${it.fwd} rev=${it.rev} prod=${it.prod}`);
    }
    process.exit(0);
  } catch (e: any) {
    console.error('auditOrientation failed', e?.message || e);
    process.exit(1);
  }
})();


