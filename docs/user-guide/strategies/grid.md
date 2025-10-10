# Grid Strategy

TL;DR
- What it does: see chooser
- Presets: Safe, Balanced, Aggressive
- Tune via key parameters below

## When to use / not to use

## Tuning guide

| Parameter | Purpose | Safe | Balanced | Aggressive |
|---|---|---|---|---|
| [Max slippage](../../parameters/catalog.md#maxSlippageBps) | Cap price impact on fills. | 30 | 50 | 80 |
| [Max notional per trade (USD)](../../parameters/catalog.md#notionalCap) | Limit exposure per fill. | 100 | 500 | 2000 |
| [Grid step percent](../../parameters/catalog.md#gridStepPercent) | Price spacing between grid levels. | 0.75 | 0.5 | 0.25 |
| [Cooldown between trades (ms)](../../parameters/catalog.md#cooldownMs) | Avoid spamming orders in bursts. |  |  |  |

## Safe preset
Wide steps, small notionals.

- [gridStepPercent](../../parameters/catalog.md#gridStepPercent): 0.75
- [notionalCap](../../parameters/catalog.md#notionalCap): 100
- [maxSlippageBps](../../parameters/catalog.md#maxSlippageBps): 30

## Balanced preset

- [gridStepPercent](../../parameters/catalog.md#gridStepPercent): 0.5
- [notionalCap](../../parameters/catalog.md#notionalCap): 500
- [maxSlippageBps](../../parameters/catalog.md#maxSlippageBps): 50

## Aggressive preset
> Risk: Overtrading in chop; monitor closely.

- [gridStepPercent](../../parameters/catalog.md#gridStepPercent): 0.25
- [notionalCap](../../parameters/catalog.md#notionalCap): 2000
- [maxSlippageBps](../../parameters/catalog.md#maxSlippageBps): 80
