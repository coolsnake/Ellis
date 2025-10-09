import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '../src/server/graph.diff';
import type { GraphSnapshot } from '../src/server/graph.types';

describe('graph.diff', () => {
  it('detects added/updated/removed nodes and edges', () => {
    const prev: GraphSnapshot = {
      version: 1,
      timestamp: 1000,
      nodes: [
        { id: 'A' },
        { id: 'B' },
      ],
      edges: [
        { id: 'A->B-Ray', source: 'A', target: 'B', dex: 'Ray' },
      ],
    };
    const next: GraphSnapshot = {
      version: 2,
      timestamp: 2000,
      nodes: [
        { id: 'A' },
        { id: 'B' },
        { id: 'C' },
      ],
      edges: [
        { id: 'A->B-Ray', source: 'A', target: 'B', dex: 'Ray', fee_bps: 30 }, // updated edge (extra field)
        { id: 'B->C-Orc', source: 'B', target: 'C', dex: 'Orc' }, // added edge
      ],
    };
    const d = diffSnapshots(prev, next);
    expect(d.version).toBe(2);
    expect(d.addedNodes.map(n => n.id)).toEqual(['C']);
    expect(d.updatedNodes).toHaveLength(0);
    expect(d.removedNodeIds).toHaveLength(0);
    // Edge A->B-Ray changes should be counted as updated
    expect(d.addedEdges.map(e => e.id)).toEqual(['B->C-Orc']);
    expect(d.updatedEdges.map(e => e.id)).toEqual(['A->B-Ray']);
    expect(d.removedEdgeIds).toHaveLength(0);
  });
});


