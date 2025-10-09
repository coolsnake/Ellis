import { describe, it, expect } from 'vitest';
import { findPathInSnapshot } from '../src/server/graph.path';
import type { GraphSnapshot } from '../src/server/graph.types';

describe('graph.path', () => {
  it('finds a simple shortest path between two mints', () => {
    const snap: GraphSnapshot = {
      version: 1,
      timestamp: Date.now(),
      nodes: [
        { id: 'A' },
        { id: 'B' },
        { id: 'C' },
      ],
      edges: [
        { id: 'A->B-X', source: 'A', target: 'B', dex: 'X' },
        { id: 'B->C-X', source: 'B', target: 'C', dex: 'X' },
      ],
    };
    const res = findPathInSnapshot(snap, 'A', 'C');
    expect(res.path).toEqual(['A', 'B', 'C']);
  });

  it('returns empty when nodes are missing', () => {
    const snap: GraphSnapshot = { version: 1, timestamp: 0, nodes: [{ id: 'A' }], edges: [] };
    const res = findPathInSnapshot(snap, 'A', 'Z');
    expect(res.path.length).toBe(0);
  });
});


