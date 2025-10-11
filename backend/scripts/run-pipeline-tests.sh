#!/usr/bin/env bash
set -euo pipefail

# Run HTTP -> graph pipeline tests sequentially (fail-fast), real E2E last
# Usage: from backend/:  bash ./scripts/run-pipeline-tests.sh [extra vitest args]
#        or via npm:      npm run test:pipeline -- [extra vitest args]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="${SCRIPT_DIR%/scripts}"
cd "$BACKEND_ROOT"

VITEST_ARGS=("$@")

tests=(
  "src/server/__tests__/meteoraBalanced.normalize.test.ts"
  "src/server/__tests__/meteoraBalanced.fetch.test.ts"
  "src/server/__tests__/meteoraBalanced.graph.include.test.ts"
  "src/server/__tests__/graph.prices.test.ts"
  "src/server/__tests__/graph.consistency.test.ts"
  "src/server/__tests__/graph.multi-hop.consistency.test.ts"
  "src/server/__tests__/graph.orientation.orca_meteora.test.ts"
)

for f in "${tests[@]}"; do
  echo "\n[pipeline] Running: $f"
  npx vitest run --pool=threads --maxWorkers=1 --reporter=basic "${VITEST_ARGS[@]}" "$f"
done

if [ "${RUN_REAL_E2E:-}" = "true" ]; then
  echo "\n[pipeline] Running: real E2E (RUN_REAL_E2E=true)"
  RUN_REAL_E2E=true npx vitest run --pool=threads --maxWorkers=1 --reporter=basic "${VITEST_ARGS[@]}" src/server/__tests__/pipeline.e2e.real.test.ts
  RUN_REAL_E2E=true npx vitest run --pool=threads --maxWorkers=1 --reporter=basic "${VITEST_ARGS[@]}" src/server/__tests__/full.pipeline.exec.e2e.real.test.ts
else
  echo "\n[pipeline] Skipping real E2E (set RUN_REAL_E2E=true to enable)"
fi

# Optional: Drift real-data smoke (read-only)
if [ "${RUN_REAL_DRIFT_E2E:-}" = "true" ]; then
  echo "\n[pipeline] Running: Drift real-data smoke (RUN_REAL_DRIFT_E2E=true)"
  RUN_REAL_DRIFT_E2E=true npx vitest run --pool=threads --maxWorkers=1 --reporter=basic "${VITEST_ARGS[@]}" src/drift/__tests__/drift.e2e.real.test.ts
else
  echo "\n[pipeline] Skipping Drift real-data smoke (set RUN_REAL_DRIFT_E2E=true to enable)"
fi

# Optional: Drift mutating (gated, requires ACK)
if [ "${RUN_DRIFT_MUTATING:-}" = "true" ]; then
  echo "\n[pipeline] Running: Drift mutating (RUN_DRIFT_MUTATING=true)"
  RUN_DRIFT_MUTATING=true DRIFT_MUTATING_MAINNET_ACK="${DRIFT_MUTATING_MAINNET_ACK:-}" npx vitest run --pool=threads --maxWorkers=1 --reporter=basic "${VITEST_ARGS[@]}" src/drift/__tests__/drift.e2e.mutating.real.test.ts
else
  echo "\n[pipeline] Skipping Drift mutating (set RUN_DRIFT_MUTATING=true to enable)"
fi

echo "\n[pipeline] All tests completed successfully."


