# Quickstart

## Prereqs
- Node.js 20 LTS
- Python 3 (for docs build only)
- Optional (live trading): Solana RPC URL, wallet keypair

## Install
```powershell
# From repo root
npm install
```
This runs postinstall for `backend/` and `frontend/` automatically.

## Run (dev)
```powershell
npm run dev
```
- Backend: Express server with APIs (default http://localhost:3001)
- Frontend: Vite dev server (default http://localhost:5173)

Open the app at http://localhost:5173

## First action (simulation)
1) Go to Strategies → Threshold or Grid.
2) Use Safe preset (small notional, tighter risk caps).
3) Click Simulate, review expected PnL and slippage.
4) If healthy, proceed; otherwise adjust [parameters](../parameters/catalog.md).

## Safe defaults
- [maxSlippageBps](../parameters/catalog.md#maxSlippageBps): 25–50 bps
- [notionalCap](../parameters/catalog.md#notionalCap): $100–$500
- [minProfitBps](../parameters/catalog.md#minProfitBps): 20–30 bps
- [cooldownMs](../parameters/catalog.md#cooldownMs): 1000–3000 ms
