# First Trade (Simulation)

## Steps
1. Open Strategies → select Threshold or Grid.
2. Choose Safe preset to start.
3. Set [maxSlippageBps](../parameters/catalog.md#maxSlippageBps) 25–50, [notionalCap](../parameters/catalog.md#notionalCap) $100–$500.
4. Simulate and review expected PnL, fees, and slippage.
5. Adjust [minProfitBps](../parameters/catalog.md#minProfitBps) or slippage if no viable routes.
6. Execute in sim; validate logs.

## Pitfalls
- Tight slippage → order rejections; widen slightly.
- High minProfit → no routes; lower cautiously.
- Large notional in illiquid pools → bad fills; reduce.
