#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3001/api}"
SIZE_USD="${SIZE_USD:-1}"
SLIPPAGE_BPS="${SLIPPAGE_BPS:-50}"

USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDT=Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN

hdr() { echo -e "\n=== $* ==="; }

pick_pool() {
  local pools_json="$1" key="$2"
  # jq fallback: pick first id in list; else try top tvl
  if command -v jq >/dev/null 2>&1; then
    echo "$pools_json" | jq -r ".${key}[0].id // empty"
  else
    echo "$pools_json" | sed -n 's/.*"id"\s*:\s*"\([^"]\+\)".*/\1/p' | head -n1
  fi
}

curl_json() { curl -sfL -H 'content-type: application/json' -X POST "$1" -d "$2"; }

hdr "Pools refresh"
curl_json "${BASE}/arb/pools/refresh" '{"force":true,"subscribe":false}' || true

hdr "Raydium AMM: discover pool"
RAY=$(curl -sfL "${BASE}/arb/pools/raydium?minUsd=100000")
RAY_AMM_ID=$(pick_pool "$RAY" amm)
echo "RAY_AMM_ID=$RAY_AMM_ID"

hdr "Raydium AMM: simulate-send USDC->USDT"
curl_json "${BASE}/arb/simulate-send/raydium-amm" "{\"path\":[\"$USDC\",\"$USDT\"],\"poolId\":\"$RAY_AMM_ID\",\"sizeUsd\":$SIZE_USD,\"slippageBps\":$SLIPPAGE_BPS}"

hdr "Raydium CLMM: discover pool"
RAY_CLMM_ID=$(pick_pool "$RAY" clmm)
echo "RAY_CLMM_ID=$RAY_CLMM_ID"

hdr "Raydium CLMM: simulate-send USDC->USDT"
curl_json "${BASE}/arb/simulate-send/raydium-clmm" "{\"path\":[\"$USDC\",\"$USDT\"],\"poolId\":\"$RAY_CLMM_ID\",\"sizeUsd\":$SIZE_USD,\"slippageBps\":$SLIPPAGE_BPS}"

hdr "Orca: discover whirlpool"
ORC=$(curl -sfL "${BASE}/arb/pools/orca?minUsd=100000")
ORC_ID=$(pick_pool "$ORC" clmm)
echo "ORC_ID=$ORC_ID"

hdr "Orca: simulate-send USDC->USDT"
curl_json "${BASE}/arb/simulate-send/orca" "{\"path\":[\"$USDC\",\"$USDT\"],\"poolId\":\"$ORC_ID\",\"sizeUsd\":$SIZE_USD,\"slippageBps\":$SLIPPAGE_BPS}"

hdr "Meteora: discover dlmm pool"
MET=$(curl -sfL "${BASE}/arb/pools/meteora?minUsd=100000")
MET_ID=$(pick_pool "$MET" clmm)
echo "MET_ID=$MET_ID"

hdr "Meteora: simulate-send USDC->USDT"
curl_json "${BASE}/arb/simulate-send/meteora" "{\"path\":[\"$USDC\",\"$USDT\"],\"poolId\":\"$MET_ID\",\"sizeUsd\":$SIZE_USD,\"slippageBps\":$SLIPPAGE_BPS}"

hdr "Done"


