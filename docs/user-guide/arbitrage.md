# Arbitrage

## TL;DR
- Discover profitable routes across sources, simulate, then execute.
- Start with safe defaults; raise risk gradually.
- Monitor fills and slippage; adjust caps and profit threshold.

## Safe defaults
- [maxSlippageBps](../parameters/catalog.md#maxSlippageBps): 25–50 bps
- [notionalCap](../parameters/catalog.md#notionalCap): $100–$500
- [minProfitBps](../parameters/catalog.md#minProfitBps): 20–30 bps
- [maxHops](../parameters/catalog.md#maxHops): 2–3
- [cooldownMs](../parameters/catalog.md#cooldownMs): 1000–3000 ms

## Steps
1. Enable desired liquidity sources (Jupiter/Raydium/Orca/Meteora).
2. Set risk caps and profitability threshold.
3. Simulate candidate routes; verify net profit after fees and slippage.
4. Execute, monitor fills, and review logs.

## Key parameters
- [Max slippage (maxSlippageBps)](../parameters/catalog.md#maxSlippageBps): cap price impact to avoid adverse fills.
- [Max notional (notionalCap)](../parameters/catalog.md#notionalCap): limit per-trade exposure.
- [Min profit (minProfitBps)](../parameters/catalog.md#minProfitBps): discard low-ev routes.
- [Max hops (maxHops)](../parameters/catalog.md#maxHops): constrain route complexity.
- [Cooldown (cooldownMs)](../parameters/catalog.md#cooldownMs): prevent rapid-fire retries.

## Examples
- Safe: maxSlippageBps=25, notionalCap=$100, minProfitBps=30, maxHops=2
- Balanced: maxSlippageBps=50, notionalCap=$500, minProfitBps=20, maxHops=3
- Aggressive: maxSlippageBps=100, notionalCap=$2000, minProfitBps=10, maxHops=4

## Common pitfalls
- Orders rejected: slippage too tight for current liquidity.
- Negative PnL: minProfit too low in volatile markets; increase threshold.
- Route failures: too many hops; reduce complexity or widen slippage modestly.
