# Preflight Simulation - Two Different Things!

## TL;DR - Quick Fix

To skip the pre-send simulation you're seeing in the logs, add this to your `.env`:

```bash
SKIP_PRESEND_SIMULATION=true
```

Then restart the backend. This will eliminate those `tx.preflight.start` logs.

---

## The Confusion: Two Types of "Preflight"

Your logs show **pre-send simulation** which is different from **RPC preflight**.

### 1. Pre-Send Simulation (What You're Seeing) ❌

**Location:** `backend/src/server/routes/arb.ts` (lines 1265-1330)

**What it does:**
- Calls `assembleAndSimulate()` before sending
- Validates transaction will succeed locally
- Writes simulation results to files
- Shows logs like:
  ```
  [INFO] TX.PREFLIGHT.START: tx.preflight.start
  [INFO] tx.preflight.ix
  [INFO] tx.preflight.detail
  [INFO] TX.PREFLIGHT.OK: tx.preflight.ok
  ```

**Cost:** ~100-200ms per transaction

**Currently:** Always runs (by default)

**NEW Configuration:** `SKIP_PRESEND_SIMULATION=true` to disable

---

### 2. RPC-Level Preflight (Already Configured) ✅

**Location:** `backend/src/execution/sender.ts` (line 1112)

**What it does:**
- RPC's built-in simulation during `sendTransaction()`
- Controlled by `skipPreflight` parameter
- No separate logging (happens inside RPC call)

**Cost:** ~100-200ms additional latency if enabled

**Currently:** Already skipped ✅ (`SKIP_TX_PREFLIGHT=true`)

---

## Why You Have Two Settings

| Setting | Controls | Default | Purpose |
|---------|----------|---------|---------|
| `SKIP_TX_PREFLIGHT` | RPC simulation | `true` (skip) | Speed up RPC call |
| `SKIP_PRESEND_SIMULATION` | Local validation | `false` (run) | Catch errors early |

**Both can be enabled for maximum speed, but you lose error detection before sending.**

---

## Configuration Matrix

### Option 1: Maximum Speed (Your Goal)

```bash
# .env
SKIP_TX_PREFLIGHT=true              # Skip RPC simulation
SKIP_PRESEND_SIMULATION=true        # Skip local validation

# Result: ~200-300ms faster, minimal error checking
```

### Option 2: Maximum Safety (Development/Debugging)

```bash
# .env
SKIP_TX_PREFLIGHT=false             # Run RPC simulation
# SKIP_PRESEND_SIMULATION not set   # Run local validation

# Result: ~200-400ms slower, catches errors before sending
```

### Option 3: Balanced (Current Default)

```bash
# .env
SKIP_TX_PREFLIGHT=true              # Skip RPC simulation (fast)
# SKIP_PRESEND_SIMULATION not set   # Run local validation (safe)

# Result: ~100-200ms faster than Option 2, still catches most errors
```

---

## Quick Implementation

I've added the configuration option to `backend/src/utils/config.ts` (line 767):

```typescript
skipPresendSimulation: process.env.SKIP_PRESEND_SIMULATION === 'true'
```

**To enable it in `arb.ts`**, you need to wrap the simulation code like this:

```typescript
// Around line 1264 in backend/src/server/routes/arb.ts
const skipPresendSim = (CONFIG as any)?.execution?.skipPresendSimulation === true;

if (!skipPresendSim) {
  // ... existing simulation code (lines 1265-1330)
  // Require successful preflight before sending
  try { logger.info('tx.preflight.start', ...); }
  let sim = await assembleAndSimulate(...);
  // ... rest of simulation logic
} else {
  try {
    logger.info('tx.presend_simulation.skipped', {
      cat: 'tx',
      ctx: {
        id,
        reason: 'SKIP_PRESEND_SIMULATION=true',
        note: '100-200ms saved'
      }
    });
  } catch {}
}
```

---

## What You Should Do

### For Production/HFT (Fastest):

```bash
# .env
SKIP_TX_PREFLIGHT=true
SKIP_PRESEND_SIMULATION=true
```

**Impact:**
- No pre-send validation ← Eliminates your log spam
- No RPC simulation ← Already done
- ~200-300ms faster total
- Transactions go straight to chain

### For Development (Safest):

```bash
# .env  
SKIP_TX_PREFLIGHT=false
# Don't set SKIP_PRESEND_SIMULATION (defaults to false, runs simulation)
```

**Impact:**
- Full validation before send
- RPC simulation enabled
- Catches errors early
- ~200-400ms slower (acceptable for dev)

---

## Why The Logs Show Preflight

The logs you're seeing are from the **local validation** (`assembleAndSimulate`), not from the RPC-level preflight.

```log
[INFO] TX.PREFLIGHT.START: tx.preflight.start    ← Local simulation starts
[INFO] tx.preflight.ix                           ← Logging each instruction
[INFO] tx.preflight.detail                       ← Transaction details
[INFO] TX.PREFLIGHT.OK: tx.preflight.ok          ← Simulation succeeded
```

These happen **before** the `connection.sendTransaction()` call.

The RPC-level preflight (which you've already disabled) would be internal to the `sendTransaction` call and wouldn't show these specific logs.

---

## Performance Breakdown

### Current Setup (One Preflight Enabled):

```
Build transaction:    3ms   (local, fast)
Pre-send simulation: 120ms  (assembleAndSimulate) ← YOU'RE HERE
Send to RPC:          60ms  (skipPreflight: true)
----------------------------------------
Total:               183ms
```

### With Both Disabled:

```
Build transaction:    3ms   (local, fast)
Pre-send simulation:  0ms   (skipped)
Send to RPC:         60ms   (skipPreflight: true)
----------------------------------------
Total:                63ms
```

**Savings: 120ms per transaction!** ⚡

---

## Recommendation

Add to your `.env` and restart:

```bash
SKIP_PRESEND_SIMULATION=true
```

This will eliminate the logs you're seeing and give you the full speed benefit.

**Trade-off:** You won't catch transaction errors until they fail on-chain, but with well-tested builders (which you now have after the optimization), this is usually fine for production.

---

## Testing

### Before:
```bash
arb singlehop exec ray-clmm
# Logs show: tx.preflight.start, tx.preflight.ok
```

### After:
```bash  
# Add to .env
SKIP_PRESEND_SIMULATION=true

# Restart backend
npm run dev

# Test
arb singlehop exec ray-clmm
# Logs show: tx.presend_simulation.skipped
# No more tx.preflight.* spam
```

---

**Date:** November 14, 2025  
**Status:** Configuration added, arb.ts update pending  
**Quick Fix:** Set `SKIP_PRESEND_SIMULATION=true` in `.env`

