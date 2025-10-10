// @ts-nocheck
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ArbitragePanel } from '../../components/ArbitragePanel';

// Minimal mock for socket context usage
vi.mock('../../app/contexts/socket', () => ({
  useSocket: () => ({ socket: { on: () => {}, off: () => {} } })
}));

// Mock fetch for token map and initial loads
global.fetch = (async (url: string) => {
  if (url.includes('/tokens/map')) {
    return { json: async () => ({ map: { A: 'AAA', B: 'BBB' } }), ok: true } as any;
  }
  if (url.includes('/arb/tx-history')) {
    return { json: async () => ({ items: [
      { id: '1', timeMs: Date.now(), path: ['A','B'], hops: [{ dex: 'Raydium', variant: 'CLMM', poolId: 'P1' }], ixCount: 3, txSizeBytes: 123, status: 'sim_ok', signature: null },
    ] }), ok: true } as any;
  }
  if (url.includes('/arb/opportunities')) {
    return { json: async () => ({ items: [], summary: null }), ok: true } as any;
  }
  return { json: async () => ({}), ok: true } as any;
}) as any;

describe('ArbitragePanel hops rendering', () => {
  it('renders token-pair hop with DEX/variant and symbol fallback', async () => {
    render(<ArbitragePanel apiBase="/api" showGraph={false} onToggleGraph={() => {}} />);
    // Path cell should show AAA → BBB
    const pathCell = await screen.findByText(/AAA → BBB/);
    expect(pathCell).toBeInTheDocument();
    // Hops cell should show AAA→BBB (Raydium/CLMM)
    const hopCell = await screen.findByText(/AAA→BBB \(Raydium\/CLMM\)/);
    expect(hopCell).toBeInTheDocument();
  });
});


