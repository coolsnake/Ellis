# Simulate Execution

- Steps to simulate
- Interpreting results
- Common pitfalls

## Single-hop DEX validation (Raydium, Orca, Meteora, Pumpswap)

Validate single-hop transaction building for common DEXes before attempting multi-hop routes.

Endpoints (all POST under `/api`):

- Raydium AMM
  - `/arb/simulate-send/raydium-amm` (build + on-chain simulation)
  - `/arb/execute/raydium-amm` (preflight + send when direct/forceDirect)
- Raydium CLMM
  - `/arb/simulate-send/raydium-clmm`
  - `/arb/execute/raydium-clmm`
- Orca (Whirlpool)
  - `/arb/simulate-send/orca`
  - `/arb/execute/orca`
- Meteora DLMM
  - `/arb/simulate-send/meteora`
  - `/arb/execute/meteora`
- Meteora Balanced (DAMM) v1
  - `/arb/simulate-send/meteora-balanced-v1`
  - `/arb/execute/meteora-balanced-v1`
- Meteora Balanced (DAMM) v2
  - `/arb/simulate-send/meteora-balanced-v2`
  - `/arb/execute/meteora-balanced-v2`
- Pumpswap
  - `/arb/simulate-send/pumpswap`
  - `/arb/execute/pumpswap`

Payload template (USDC→USDT with a known `poolId`, 1 USD, 50 bps):

```json
{
  "path": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN"],
  "poolId": "<pool_id>",
  "sizeUsd": 1,
  "slippageBps": 50,
  "forceDirect": true
}
```

Discover pools:

- Raydium: `GET /arb/pools/raydium?minUsd=100000`
- Orca: `GET /arb/pools/orca?minUsd=100000`
- Meteora DLMM: `GET /arb/pools/meteora?minUsd=100000`
- Meteora Balanced (DAMM): `GET /arb/pools/meteora-balanced?minUsd=10000`
- Pumpswap: `GET /arb/pools/pumpswap?minUsd=1000`

Developer smoke script:

```bash
bash scripts/singlehop-smoke.sh
# env: BASE, SIZE_USD, SLIPPAGE_BPS
```

Live test (opt-in, requires server and mainnet RPC):

```bash
# Test standard DEXes (Raydium, Orca, Meteora DLMM)
RUN_LIVE_SINGLEHOP=true \
vitest run backend/tests/singlehop.live.test.ts

# Optional actual broadcast after preflight success:
RUN_LIVE_SINGLEHOP=true RUN_LIVE_SINGLEHOP_EXECUTE=true \
vitest run backend/tests/singlehop.live.test.ts

# Test new DEXes (Meteora Balanced v1/v2, Pumpswap)
RUN_LIVE_SINGLEHOP=true \
vitest run backend/tests/singlehop.newdex.test.ts

# Optional actual broadcast after preflight success:
RUN_LIVE_SINGLEHOP=true RUN_LIVE_SINGLEHOP_EXECUTE=true \
vitest run backend/tests/singlehop.newdex.test.ts
```