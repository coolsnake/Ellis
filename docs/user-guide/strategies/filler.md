## Filler JIT-avoidance settings

These settings help avoid wasting attempts on taker orders that are likely to be captured by atomic JIT place-and-make transactions.

Parameters (backend `FillerConfig`, UI: New Filler Bot form):

- skipYoungOrderMs: Number
  - Do not attempt orders younger than this age in milliseconds.
  - Example: 700

- requireExistingMakers: Boolean
  - Only attempt fills if the DLOB already shows existing maker orders for the taker.
  - Example: true

- minMakerCountPerNode: Number
  - Minimum existing makers required on the node before attempting a fill.
  - Example: 1 or 2

- denyJitTakersTtlMs: Number
  - After a likely JIT preemption (e.g. RevertFill), skip the taker for this TTL window.
  - Example: 15000

- minTipFloorToAttemptLamports: Number
  - Skip attempts if current Jito tip floor is at or above this lamports value.
  - Example: 0 (disabled) or a market-specific floor.

Recommended starting values:

- requireExistingMakers = true
- minMakerCountPerNode = 1
- skipYoungOrderMs = 700
- denyJitTakersTtlMs = 15000
- minTipFloorToAttemptLamports = 0 (enable later if needed)

Notes:

- These heuristics do not change matching behavior; they reduce attempts on low-probability fills.
- You can still enable/disable AMM fills via Allow AMM/JIT Fills.
- Tune values per deployment based on observed preemption rates and cost/revenue metrics.


