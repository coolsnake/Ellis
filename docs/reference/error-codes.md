# Error Codes

| Code | Meaning | Likely Cause | Fix |
|---|---|---|---|
| REJECTION_SLIPPAGE | Order rejected due to slippage guard | maxSlippageBps too low for liquidity/volatility | Increase slippage within recommended ranges |
| ROUTE_NOT_FOUND | No viable path found | Min profit too high; disabled sources; hop cap too low | Lower minProfitBps, enable sources, raise maxHops |
| INSUFFICIENT_LIQUIDITY | Pool depth too low for size | Notional too high; fragmented liquidity | Lower notionalCap; allow more hops |
| RPC_RATE_LIMIT | RPC throttling | Provider limits exceeded | Add cooldownMs; use higher-tier RPC |
| WALLET_FUNDS_LOW | Not enough SOL/USDC | Fees/collateral not covered | Fund wallet; lower size |
| SIGNATURE_REJECTED | User denied wallet signature | User cancelled or wallet locked | Re-open wallet and approve |
| TX_TOO_LARGE | Transaction size exceeded | Too many hops/instructions | Reduce hops; split trade |
| TIMEOUT | Submission/confirmation took too long | Network congestion | Retry with backoff; monitor RPC |
| PRICE_FEED_STALE | Quotes not updating | Feed outage / network | Wait or switch feed/RPC |

See also:
- [Troubleshooting](../troubleshooting/index.md)
- Parameter guards: [maxSlippageBps](../parameters/catalog.md#maxSlippageBps), [notionalCap](../parameters/catalog.md#notionalCap), [maxHops](../parameters/catalog.md#maxHops)
