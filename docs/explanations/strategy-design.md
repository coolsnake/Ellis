# Strategy Design

## Principles
- Protect first: caps on slippage and notional.
- Prefer simplicity: fewer hops reduce failure risk.
- Progressive disclosure: presets before manual tuning.

## Presets rationale
- Safe: discovery, low exposure, tight guards.
- Balanced: daily operation, moderate risk/throughput.
- Aggressive: capture scarce alpha; requires close monitoring.

## Tuning
- Raise minProfitBps when volatility inflates impact.
- Lower notionalCap in thin markets.
- Adjust gridStepPercent to match range/trend regime.
