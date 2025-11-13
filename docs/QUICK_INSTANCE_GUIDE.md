# Quick Instance Selection Guide

## TL;DR

**For 500 nodes / 1200 edges → 100-200ms target:**

👉 **Start with `c2-standard-4`** (~$145/month)

## Quick Decision Tree

```
Is your graph < 1000 nodes?
├─ YES → c2-standard-4 (4 vCPU, 16GB)
└─ NO → c2-standard-8 (8 vCPU, 32GB)

Need latest hardware?
├─ YES → c3-standard-4 (newer, slightly better)
└─ NO → c2-standard-4 (proven, cheaper)
```

## Instance Comparison

| Instance | vCPU | RAM | Cost/Month | Best For |
|----------|------|-----|------------|----------|
| **c2-standard-4** ⭐ | 4 | 16GB | ~$145 | **Start here** |
| c2-standard-8 | 8 | 32GB | ~$290 | Larger graphs (2000+ nodes) |
| c3-standard-4 | 4 | 16GB | ~$160 | Latest hardware preference |
| n2-standard-4 | 4 | 16GB | ~$138 | Budget-conscious alternative |

## Setup Steps

1. **Create GCP Instance**
   ```bash
   gcloud compute instances create lockstone-detector \
     --machine-type=c2-standard-4 \
     --zone=us-central1-a \
     --image-family=ubuntu-2204-lts \
     --image-project=ubuntu-os-cloud \
     --boot-disk-size=50GB \
     --boot-disk-type=pd-ssd
   ```

2. **Rebuild with Optimizations**
   ```bash
   cd arb-rs
   cargo build --release  # Now uses optimized profile
   ```

3. **Deploy and Test**
   ```bash
   make deploy
   # Monitor detection_duration_ms metric
   ```

4. **Verify Performance**
   - Check `detection_duration_ms` in metrics
   - Target: p95 < 200ms
   - If still slow, upgrade to c2-standard-8

## Expected Performance

| Graph Size | Current (e2) | c2-standard-4 | Improvement |
|------------|---------------|----------------|-------------|
| 500 nodes / 1200 edges | > 500ms | **100-150ms** | **3-5x faster** |
| 1000 nodes / 3000 edges | N/A | **200-300ms** | Scales well |

## Cost Optimization Tips

1. **Use Committed Use Discounts** (1-year commitment)
   - Save ~30% on monthly costs
   - Good if running 24/7

2. **Preemptible Instances** (NOT recommended)
   - 80% cheaper but can be terminated
   - Not suitable for production detector

3. **Sustained Use Discounts** (automatic)
   - 20-30% discount after 25% monthly usage
   - Applied automatically

## Monitoring

Track these metrics after migration:

```bash
# Check detection times
curl http://localhost:4010/metrics | grep detection_duration_ms

# Monitor CPU usage
htop  # or top

# Check memory usage
free -h  # Should be < 1GB for detector
```

## Troubleshooting

**Still slow after migration?**
1. Verify build used `--release` flag
2. Check CPU governor: `cpupower frequency-info`
3. Ensure no other heavy processes running
4. Consider upgrading to c2-standard-8

**Memory issues?**
- Shouldn't happen (< 1GB needed)
- Check for memory leaks in graph updates
- Monitor with `valgrind` if needed

## Next Steps

1. ✅ Read full guide: `docs/INFRASTRUCTURE_RECOMMENDATIONS.md`
2. ✅ Create c2-standard-4 instance
3. ✅ Rebuild with optimizations (already added to Cargo.toml)
4. ✅ Deploy and measure performance
5. ✅ Adjust instance size if needed

