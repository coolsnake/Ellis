# Data Flows

## Arbitrage
1. Pool discovery/refresh per source (timers/websockets).
2. Normalize pools → build graph snapshot.
3. Find candidate routes; apply minProfitBps.
4. Simulate with slippage; estimate fees and impact.
5. Execute with risk caps (slippage, notional, hops).
6. Emit tx events; record fills; update history.

## Drift
1. Market data (ladders, funding) fetched.
2. Strategy decides placements based on presets.
3. Orders placed under leverage/liq buffers.
4. Monitor fills and risk; pause on guards.
