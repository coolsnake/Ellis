import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable mock data for graph edges; tests will assign per-case
let mockEdges: Array<{ pool_id: string; dex: string }> = [];

vi.mock('../src/server/graph.js', () => {
  return {
    getGraphSnapshot: vi.fn(async (_force?: boolean) => {
      return { nodes: [], edges: mockEdges } as any;
    }),
  };
});

// Import after mocks so dynamic imports in code under test resolve to our mock
import { getWsTargets } from '../src/server/pools';

describe('getWsTargets', () => {
  beforeEach(() => {
    mockEdges = [];
  });

  it('counts per-DEX targets and de-duplicates -rev pool ids', async () => {
    mockEdges = [
      { pool_id: 'ORC1', dex: 'Orca' },
      { pool_id: 'ORC1-rev', dex: 'Orca' }, // reversed duplicate
      { pool_id: 'ORC2', dex: 'Orca' },
      { pool_id: 'RAY1', dex: 'Raydium' },
      { pool_id: 'MET1', dex: 'Meteora' },
      { pool_id: 'OTHER', dex: 'Unknown' },
    ];

    const tgt = await getWsTargets();
    expect(tgt.orca.target).toBe(2); // ORC1 & ORC2 (ORC1-rev deduped)
    expect(tgt.raydium.target).toBe(1);
    expect(tgt.meteora.target).toBe(1);
  });

  it('returns zeros when graph has no edges', async () => {
    mockEdges = [];
    const tgt = await getWsTargets();
    expect(tgt.orca.target).toBe(0);
    expect(tgt.raydium.target).toBe(0);
    expect(tgt.meteora.target).toBe(0);
  });
});


