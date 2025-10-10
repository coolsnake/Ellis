# Troubleshooting

## Orders rejected

Checks:
- Increase maxSlippageBps within recommended range.
- Verify liquidity feeds are fresh.
- Reduce notionalCap in low-liquidity markets.

See also:
- ../parameters/catalog.md#maxSlippageBps
- ../reference/error-codes.md

## No routes found

Checks:
- Increase maxHops slightly.
- Enable more liquidity sources.
- Lower minProfitBps threshold.

See also:
- ../parameters/catalog.md#maxHops
- ../parameters/catalog.md#minProfitBps

## Bad fills (high slippage)

Checks:
- Lower maxSlippageBps.
- Lower notionalCap.
- Avoid volatile pairs; check pool depth.

See also:
- ../parameters/catalog.md#maxSlippageBps
- ../parameters/catalog.md#notionalCap
