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
  npx vitest run --threads=false --reporter=basic "${VITEST_ARGS[@]}" "$f"
done

if [ "${RUN_REAL_E2E:-}" = "true" ]; then
  echo "\n[pipeline] Running: real E2E (RUN_REAL_E2E=true)"
  RUN_REAL_E2E=true npx vitest run --threads=false --reporter=basic "${VITEST_ARGS[@]}" src/server/__tests__/pipeline.e2e.real.test.ts
else
  echo "\n[pipeline] Skipping real E2E (set RUN_REAL_E2E=true to enable)"
fi

echo "\n[pipeline] All tests completed successfully."


