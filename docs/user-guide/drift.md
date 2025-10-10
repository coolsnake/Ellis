# Drift

## TL;DR
- Trade via Drift with risk caps and controlled slippage.
- Start in simulation; move to live only after verifying fills.

## Safe defaults
- [maxSlippageBps](../parameters/catalog.md#maxSlippageBps): 25–50 bps
- [notionalCap](../parameters/catalog.md#notionalCap): $100–$500
- [cooldownMs](../parameters/catalog.md#cooldownMs): 1000–3000 ms

## Steps
1. Connect wallet and verify balances.
2. Choose order type and set risk caps.
3. Simulate; review expected fills and risk.
4. Execute with small notional; review logs.

## Key parameters
- [Max slippage](../parameters/catalog.md#maxSlippageBps): protect fills.
- [Max notional](../parameters/catalog.md#notionalCap): bound exposure.
- [Cooldown](../parameters/catalog.md#cooldownMs): dampen burst trading.

## Pitfalls
- Overfills in volatile markets → lower notionalCap and slippage.
- Rejections from stale prices → confirm feed freshness and retry.
