import { describe, it, expect } from 'vitest';
import { getGraphSnapshot } from '../graph.js';

describe('orca/meteora forward-reverse reciprocity', () => {
  it('forward * reverse ~ 1 for orca and meteora', async () => {
    const snap = await getGraphSnapshot(true);
    const byId = new Map(snap.edges.map(e => [e.id, e]));
    for (const e of snap.edges) {
      if (e.dex !== 'Orca' && e.dex !== 'Meteora') continue;
      const rid = e.pool_id ? `${e.pool_id}-rev` : `${e.target}->${e.source}-${e.dex}`;
      const r = byId.get(rid);
      if (!r) continue;
      const f = Number((e as any).price_a_per_b || 0);
      const v = Number((r as any).price_a_per_b || 0);
      if (!(f > 0) || !(v > 0)) continue;
      const prod = f * v;
      expect(prod).toBeGreaterThan(0.98);
      expect(prod).toBeLessThan(1.02);
    }
  });
});