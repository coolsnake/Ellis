# Infrastructure Recommendations for Detector Performance

## Current Situation

- **Current Instance**: e2-standard (4GB RAM)
- **Graph Size**: 500 nodes, 1200 edges
- **Current Performance**: Inadequate (exceeds target)
- **Target Performance**: 100-200ms per detector run

## Workload Analysis

### Algorithm Characteristics

The detector uses **Bellman-Ford algorithm** for negative cycle detection:

- **Time Complexity**: O(V × E) where V = nodes, E = edges
- **For 500 nodes, 1200 edges**:
  - ~500 iterations (V-1)
  - Each iteration scans all 1200 edges
  - Total: ~600,000 edge operations per detection run
  - Plus cycle detection pass: additional ~600,000 operations
  - **Total: ~1.2M operations per run**

### Resource Requirements

**Memory**: Very low (< 1GB)
- Graph data: ~500 nodes × 50 bytes + 1200 edges × 100 bytes ≈ 145KB
- Algorithm working sets (dist/pred arrays): ~8KB
- Total memory footprint: < 500MB

**CPU**: High single-threaded performance required
- CPU-intensive floating point math (logarithms, multiplications)
- Sequential graph traversal (cache-friendly)
- Single-threaded algorithm (Bellman-Ford is inherently sequential)
- No I/O during detection

**Conclusion**: This is a **CPU-bound workload**, not memory-bound. The bottleneck is single-threaded CPU performance.

## Recommended Instance Types

### Option 1: c2-standard-4 (RECOMMENDED)

**Specs:**
- 4 vCPUs (Intel Skylake, 3.8 GHz base, 3.9 GHz turbo)
- 16 GB RAM
- **Estimated Cost**: ~$0.20/hour (~$145/month)

**Why this works:**
- **CPU-optimized** instance family (c2 = compute-optimized)
- High single-threaded performance (3.8-3.9 GHz)
- More than enough memory (16GB vs <1GB needed)
- Good price/performance ratio

**Expected Performance**: Should achieve 100-200ms target for 500 nodes/1200 edges

---

### Option 2: c2-standard-8 (For Future Growth)

**Specs:**
- 8 vCPUs (Intel Skylake, 3.8 GHz base, 3.9 GHz turbo)
- 32 GB RAM
- **Estimated Cost**: ~$0.40/hour (~$290/month)

**Why consider:**
- Same CPU performance per core as c2-standard-4
- Room for graph growth (1000+ nodes, 3000+ edges)
- Can handle multiple concurrent operations if needed

---

### Option 3: c3-standard-4 (Latest Generation)

**Specs:**
- 4 vCPUs (Intel Sapphire Rapids, 3.5 GHz base, 3.7 GHz turbo)
- 16 GB RAM
- **Estimated Cost**: ~$0.22/hour (~$160/month)

**Why consider:**
- Newer generation (better IPC - instructions per cycle)
- Slightly better single-threaded performance despite lower clock
- Better for long-term use

**Expected Performance**: Should achieve 100-200ms target, potentially better than c2

---

### Option 4: n2-standard-4 (Balanced Alternative)

**Specs:**
- 4 vCPUs (Intel Cascade Lake, 2.8 GHz base, 3.4 GHz turbo)
- 16 GB RAM
- **Estimated Cost**: ~$0.19/hour (~$138/month)

**Why consider:**
- Balanced general-purpose instance
- Better CPU performance than e2
- Slightly cheaper than c2
- Good if you need more balanced workload

**Expected Performance**: Should achieve 100-200ms target, but may be slower than c2/c3

---

## Performance Comparison

| Instance Type | vCPUs | CPU Type | Base GHz | Turbo GHz | Est. Cost/Month | Performance Rank |
|--------------|-------|----------|----------|-----------|-----------------|------------------|
| **c3-standard-4** | 4 | Sapphire Rapids | 3.5 | 3.7 | ~$160 | ⭐⭐⭐⭐⭐ Best |
| **c2-standard-4** | 4 | Skylake | 3.8 | 3.9 | ~$145 | ⭐⭐⭐⭐ Excellent |
| **n2-standard-4** | 4 | Cascade Lake | 2.8 | 3.4 | ~$138 | ⭐⭐⭐ Good |
| **e2-standard** | 2 | Any | 2.0-2.6 | 2.0-3.1 | ~$50 | ⭐⭐ Current (inadequate) |

## Recommendations

### Immediate Action (Start Here)

**Start with `c2-standard-4`**:
- Best price/performance for your workload
- Proven CPU-optimized instance type
- Should easily hit 100-200ms target
- Room to grow to 1000+ nodes if needed

### Migration Path

1. **Phase 1**: Deploy `c2-standard-4`
   - Test with 500 nodes/1200 edges
   - Measure actual detection times
   - Target: < 200ms consistently

2. **Phase 2**: If performance is still inadequate
   - Upgrade to `c2-standard-8` (more cores for parallel operations)
   - OR switch to `c3-standard-4` (better IPC)

3. **Phase 3**: If graph grows significantly (2000+ nodes)
   - Consider `c2-standard-8` or `c3-standard-8`
   - Monitor memory usage (should still be < 2GB)

## Additional Optimizations

### Build Optimizations

Ensure Rust is built with optimizations:

```bash
# In arb-rs directory
cargo build --release

# Or add to Cargo.toml:
[profile.release]
opt-level = 3
lto = true
codegen-units = 1
```

### Runtime Optimizations

1. **CPU Governor**: Set to `performance` mode (if on Linux)
   ```bash
   sudo cpupower frequency-set -g performance
   ```

2. **Process Priority**: Run detector with higher priority
   ```bash
   nice -n -10 ./arb-rs
   ```

3. **CPU Affinity**: Pin to specific cores (if needed)
   ```bash
   taskset -c 0,1 ./arb-rs
   ```

### Monitoring

Track these metrics:
- `detection_duration_ms` (target: < 200ms)
- CPU utilization (should be high during detection)
- Memory usage (should be < 1GB)
- Graph size (nodes/edges)

## Cost Analysis

### Monthly Costs (Estimated)

| Instance | Hourly | Monthly (730h) | Annual |
|----------|--------|----------------|--------|
| c2-standard-4 | $0.20 | ~$145 | ~$1,750 |
| c2-standard-8 | $0.40 | ~$290 | ~$3,500 |
| c3-standard-4 | $0.22 | ~$160 | ~$1,900 |
| n2-standard-4 | $0.19 | ~$138 | ~$1,650 |

**Note**: Actual costs vary by region and include sustained use discounts.

## Testing Plan

1. **Baseline Test** (on current e2):
   - Run detector 100 times
   - Record `detection_duration_ms` for each
   - Calculate p50, p95, p99 percentiles

2. **New Instance Test** (on c2-standard-4):
   - Same test procedure
   - Compare percentiles
   - Verify p95 < 200ms

3. **Load Test**:
   - Gradually increase graph size
   - Find breaking point where performance degrades
   - Plan for future growth

## Conclusion

**Recommended Starting Point**: `c2-standard-4`
- CPU-optimized for your workload
- Should achieve 100-200ms target easily
- Good price/performance balance
- Room for growth

**Expected Improvement**: 3-5x faster than current e2 instance, easily hitting 100-200ms target.

