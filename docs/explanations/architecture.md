# Architecture

## Components
- Frontend (Vite/React): UI, tooltips linking to Parameters Catalog.
- Backend (Node/Express): routes for pools, graph, strategies, execution.
- arb-rs (Rust): optional fast pathfinding/execution support.

## Data
- Liquidity sources: Raydium/Orca/Meteora/Drift.
- Graph: normalized pools → snapshot → diff → pathfinding.
- Pricing/slippage: simulation before execution; guards at send.

## Realtime
- Socket.IO events for tx lifecycle and feeds.
- Logs streamed for sim/send/fill diagnostics.

## Integrations
- Jupiter/DEX SDKs for routing and quotes.
- Drift SDK for perps, liquidator, leveraged grid.
