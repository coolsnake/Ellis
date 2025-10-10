# Threshold Strategy

TL;DR
- What it does: see chooser
- Presets: Safe, Balanced, Aggressive
- Tune via key parameters below

## When to use / not to use

## Tuning guide

| Parameter | Purpose | Safe | Balanced | Aggressive |
|---|---|---|---|---|
| [Max slippage](../../parameters/catalog.md#maxSlippageBps) | Cap price impact on fills. | 25 | 50 | 100 |
| [Max notional per trade (USD)](../../parameters/catalog.md#notionalCap) | Limit exposure per fill. | 100 | 500 | 2000 |
| [Minimum target profit](../../parameters/catalog.md#minProfitBps) | Discard routes below this net profit. | 30 | 20 | 10 |
| [Cooldown between trades (ms)](../../parameters/catalog.md#cooldownMs) | Avoid spamming orders in bursts. |  |  |  |
| [Max route hops](../../parameters/catalog.md#maxHops) | Cap path complexity to control execution risk. | 2 | 3 | 4 |

## Safe preset
Conservative fills for discovery.

- [maxSlippageBps](../../parameters/catalog.md#maxSlippageBps): 25
- [notionalCap](../../parameters/catalog.md#notionalCap): 100
- [minProfitBps](../../parameters/catalog.md#minProfitBps): 30
- [maxHops](../../parameters/catalog.md#maxHops): 2

## Balanced preset

- [maxSlippageBps](../../parameters/catalog.md#maxSlippageBps): 50
- [notionalCap](../../parameters/catalog.md#notionalCap): 500
- [minProfitBps](../../parameters/catalog.md#minProfitBps): 20
- [maxHops](../../parameters/catalog.md#maxHops): 3

## Aggressive preset
> Risk: Higher adverse selection and failure probability.

- [maxSlippageBps](../../parameters/catalog.md#maxSlippageBps): 100
- [notionalCap](../../parameters/catalog.md#notionalCap): 2000
- [minProfitBps](../../parameters/catalog.md#minProfitBps): 10
- [maxHops](../../parameters/catalog.md#maxHops): 4
