import { describe, it, expect } from 'vitest';
import { getTokenMeta } from '../execution/resolver/tokenMeta.js';

describe('token meta resolver', () => {
  it('returns decimals and program', async () => {
    // This test executes against real implementation; just assert shape and types
    const SOL = 'So11111111111111111111111111111111111111112';
    const meta = await getTokenMeta(SOL);
    expect(typeof meta.decimals).toBe('number');
    expect(meta.program === 'spl-token' || meta.program === 'token-2022').toBe(true);
  });
});


