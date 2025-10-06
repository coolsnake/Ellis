import { describe, it, expect } from 'vitest';

describe('pool universe filtering overlap and anchor bridging', () => {
  it('filters pools strictly when anchor bridging disabled; includes anchors when enabled', async () => {
    const { filterPoolsByUniverse } = await import('../src/server/universe');
    const uni = new Set<string>(['A', 'B', 'C']);
    const anchors = new Set<string>(['SOL']);
    const pools = {
      amm: [
        { mint_a: 'A', mint_b: 'B' }, // both in universe
        { mint_a: 'SOL', mint_b: 'X' }, // anchor bridging candidate
        { mint_a: 'X', mint_b: 'Y' }, // neither
      ],
      clmm: [
        { mint_a: 'B', mint_b: 'C' }, // both in universe
        { mint_a: 'C', mint_b: 'Z' }, // one in universe, one not
      ],
    };

    const strict = filterPoolsByUniverse(pools as any, uni, false, anchors);
    expect(strict.amm.length).toBe(1);
    expect(strict.clmm.length).toBe(1);

    const bridged = filterPoolsByUniverse(pools as any, uni, true, anchors);
    // Adds the SOL-X AMM due to anchor; does not add C-Z because Z is not anchor and only one in universe
    expect(bridged.amm.length).toBe(2);
    expect(bridged.clmm.length).toBe(1);
  });
});


